import type { StructuredModel } from "../model";
import { createAnthropicModel } from "./anthropic";
import { createClaudeCliModel } from "./claude-cli";

export const MODEL_PROVIDERS = ["claude-cli", "anthropic"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderConfig {
  provider: ModelProvider;
  /** Provider default when omitted: "sonnet" for the CLI, "claude-sonnet-5" for the API. */
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  claudeCliPath?: string;
  anthropicApiKey?: string;
}

export function createStructuredModel(config: ModelProviderConfig): StructuredModel {
  switch (config.provider) {
    case "claude-cli":
      return createClaudeCliModel({
        command: config.claudeCliPath,
        model: config.model,
        effort: config.effort,
        timeoutMs: config.timeoutMs,
      });
    case "anthropic":
      return createAnthropicModel({
        apiKey: config.anthropicApiKey,
        model: config.model,
        effort: config.effort,
        timeoutMs: config.timeoutMs,
      });
  }
}
