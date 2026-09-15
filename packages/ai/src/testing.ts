import { emptyUsage, ModelCallError, type StructuredModel, type StructuredRequest } from "./model";

export interface ScriptedModel extends StructuredModel {
  readonly requests: StructuredRequest[];
}

/**
 * A model that replays scripted outputs in order (the last one repeats). An `Error` entry is thrown
 * instead of returned. For tests and golden-fixture replays; never calls a provider.
 */
export function createScriptedModel(
  outputs: Array<unknown | Error>,
  options: { provider?: string; model?: string } = {},
): ScriptedModel {
  if (outputs.length === 0) throw new Error("createScriptedModel needs at least one output");
  const requests: StructuredRequest[] = [];
  return {
    provider: options.provider ?? "scripted",
    requests,
    async generate(request) {
      requests.push(request);
      const next = outputs[Math.min(requests.length - 1, outputs.length - 1)];
      if (next instanceof Error) throw next;
      return {
        output: next,
        provider: options.provider ?? "scripted",
        model: options.model ?? "scripted-model",
        usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 50 },
        durationMs: 5,
      };
    },
  };
}

export { ModelCallError };
export { contextFor, fileFrom, lines, skippedFile } from "./concept-mapping/golden/context";
export { goldenFixtures, type GoldenFixture } from "./concept-mapping/golden/fixtures";
export { scoreGolden, type GoldenScore } from "./concept-mapping/golden/score";
