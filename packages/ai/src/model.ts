/**
 * Provider-neutral structured generation. Adapters return the model's raw structured output;
 * callers validate it with Zod before trusting any field.
 */

export const MODEL_ERROR_CODES = [
  "provider_unavailable",
  "auth_failed",
  "rate_limited",
  "timeout",
  "refused",
  "output_truncated",
  "invalid_output",
  "request_rejected",
  "provider_error",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set([
  "provider_unavailable",
  "rate_limited",
  "timeout",
  "invalid_output",
  "provider_error",
]);

/**
 * A failed model call. The message is only the code: provider errors and CLI output can echo
 * request content, so nothing from them is copied into the message.
 */
export class ModelCallError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ModelErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`model call failed: ${code}`, options);
    this.name = "ModelCallError";
    this.retryable = RETRYABLE.has(code);
  }
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface StructuredRequest {
  /** Stable instructions; safe to cache. Never contains repository content. */
  system: string;
  /** The per-call message, including delimited untrusted data. */
  prompt: string;
  /** JSON Schema for the output, restricted to keywords every provider supports. */
  jsonSchema: Record<string, unknown>;
}

export interface StructuredResult {
  output: unknown;
  provider: string;
  model: string;
  usage: ModelUsage;
  durationMs: number;
}

export interface StructuredModel {
  readonly provider: string;
  generate(
    request: StructuredRequest,
    options?: { signal?: AbortSignal },
  ): Promise<StructuredResult>;
}

export const emptyUsage = (): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});
