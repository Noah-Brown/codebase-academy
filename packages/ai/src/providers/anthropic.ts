import Anthropic from "@anthropic-ai/sdk";
import { ModelCallError, type ModelErrorCode, type StructuredModel } from "../model";

/** Structured generation through the Claude API with an API key, billed per token. */

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** The part of the SDK client this adapter uses, so tests can substitute a fake. */
export type AnthropicMessagesClient = Pick<Anthropic, "messages">;

export interface AnthropicModelOptions {
  /** Defaults to the SDK's own credential resolution (`ANTHROPIC_API_KEY`, then other sources). */
  apiKey?: string;
  model?: string;
  effort?: AnthropicEffort;
  maxTokens?: number;
  timeoutMs?: number;
  client?: AnthropicMessagesClient;
}

export function anthropicErrorCode(error: unknown): ModelErrorCode {
  if (error instanceof Anthropic.AuthenticationError) return "auth_failed";
  if (error instanceof Anthropic.PermissionDeniedError) return "auth_failed";
  if (error instanceof Anthropic.RateLimitError) return "rate_limited";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIUserAbortError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "provider_unavailable";
  if (error instanceof Anthropic.BadRequestError) return "request_rejected";
  if (error instanceof Anthropic.NotFoundError) return "request_rejected";
  if (error instanceof Anthropic.APIError && error.status === 413) return "request_rejected";
  return "provider_error";
}

export function createAnthropicModel(options: AnthropicModelOptions = {}): StructuredModel {
  const model = options.model ?? "claude-sonnet-5";
  const effort = options.effort ?? "medium";
  const maxTokens = options.maxTokens ?? 16_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });

  return {
    provider: "anthropic",
    async generate(request, callOptions = {}) {
      const started = Date.now();
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            // The system prompt is identical across pull requests, so it is cached.
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: request.prompt }],
            output_config: {
              effort,
              format: { type: "json_schema", schema: request.jsonSchema },
            },
          },
          { signal: callOptions.signal, timeout: timeoutMs },
        );
      } catch (error) {
        throw new ModelCallError(anthropicErrorCode(error), { cause: error });
      }

      if (response.stop_reason === "refusal") throw new ModelCallError("refused");
      if (response.stop_reason === "max_tokens") throw new ModelCallError("output_truncated");
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ModelCallError("invalid_output");
      }

      return {
        output,
        provider: "anthropic",
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        durationMs: Date.now() - started,
      };
    },
  };
}
