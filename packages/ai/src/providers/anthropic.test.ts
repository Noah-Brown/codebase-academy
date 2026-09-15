import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicErrorCode,
  createAnthropicModel,
  type AnthropicMessagesClient,
} from "./anthropic";

function fakeClient(result: unknown) {
  const create = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { messages: { create } } as unknown as AnthropicMessagesClient, create };
}

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: '{"mappings":' },
    { type: "text", text: "[]}" },
  ],
  usage: {
    input_tokens: 50,
    output_tokens: 20,
    cache_read_input_tokens: 4_000,
    cache_creation_input_tokens: null,
  },
  ...overrides,
});

const request = { system: "rules", prompt: "data", jsonSchema: { type: "object" } };

describe("createAnthropicModel", () => {
  it("sends a cached system prompt with a JSON Schema output format", async () => {
    const { client, create } = fakeClient(message());
    const result = await createAnthropicModel({ client }).generate(request);

    expect(create).toHaveBeenCalledWith(
      {
        model: "claude-sonnet-5",
        max_tokens: 16_000,
        system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "data" }],
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: { type: "object" } },
        },
      },
      { signal: undefined, timeout: 300_000 },
    );
    expect(result).toMatchObject({
      output: { mappings: [] },
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        cacheReadInputTokens: 4_000,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it.each([
    ["refusal", "refused"],
    ["max_tokens", "output_truncated"],
  ])("maps stop_reason %s to %s", async (stopReason, code) => {
    const { client } = fakeClient(message({ stop_reason: stopReason }));
    await expect(createAnthropicModel({ client }).generate(request)).rejects.toMatchObject({
      code,
    });
  });

  it("rejects text that is not JSON", async () => {
    const { client } = fakeClient(message({ content: [{ type: "text", text: "Sure! Here" }] }));
    await expect(createAnthropicModel({ client }).generate(request)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("wraps SDK errors in a ModelCallError", async () => {
    const { client } = fakeClient(
      new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()),
    );
    await expect(createAnthropicModel({ client }).generate(request)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });
});

describe("anthropicErrorCode", () => {
  it.each([
    [new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()), "auth_failed"],
    [new Anthropic.PermissionDeniedError(403, undefined, "denied", new Headers()), "auth_failed"],
    [new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()), "rate_limited"],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIConnectionError({ message: "offline" }), "provider_unavailable"],
    [new Anthropic.BadRequestError(400, undefined, "bad", new Headers()), "request_rejected"],
    [
      new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()),
      "provider_error",
    ],
    [new Error("boom"), "provider_error"],
  ])("maps %s", (error, code) => {
    expect(anthropicErrorCode(error)).toBe(code);
  });
});
