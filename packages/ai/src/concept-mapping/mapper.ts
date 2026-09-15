import type { CurriculumGraph } from "@academy/curriculum";
import type { AnalysisContext } from "@academy/github";
import type { MappedConcept } from "@academy/learning";
import { ModelCallError, type ModelUsage, type StructuredModel } from "../model";
import { defaultConceptMapperConfig, type ConceptMapperConfig } from "./config";
import { buildConceptMapperPrompt } from "./prompt";
import { mapperOutputJsonSchema, mapperOutputSchema } from "./schema";
import { emptyDropCounts, validateMapperOutput, type DropCounts } from "./validate";

export interface ConceptMappingCall {
  provider: string;
  model: string;
  usage: ModelUsage;
  durationMs: number;
}

export interface ConceptMappingResult {
  /** Validated mappings, best first. Empty means the change does not map cleanly. */
  mappings: MappedConcept[];
  dropped: DropCounts;
  /** Null when no model call was needed. */
  call: ConceptMappingCall | null;
  skippedReason: "no_included_files" | null;
}

/**
 * Map one pull request's analysis context to curriculum concepts. Throws `ModelCallError` when the
 * provider fails or returns output that does not match the schema.
 */
export async function mapConcepts(input: {
  model: StructuredModel;
  context: AnalysisContext;
  graph: CurriculumGraph;
  config?: ConceptMapperConfig;
  nonce?: string;
  signal?: AbortSignal;
}): Promise<ConceptMappingResult> {
  const config = input.config ?? defaultConceptMapperConfig;
  if (!input.context.files.some((file) => file.included)) {
    return {
      mappings: [],
      dropped: emptyDropCounts(),
      call: null,
      skippedReason: "no_included_files",
    };
  }

  const { system, prompt } = buildConceptMapperPrompt({
    context: input.context,
    graph: input.graph,
    config,
    nonce: input.nonce,
  });
  const result = await input.model.generate(
    { system, prompt, jsonSchema: mapperOutputJsonSchema },
    { signal: input.signal },
  );

  const parsed = mapperOutputSchema.safeParse(result.output);
  if (!parsed.success) throw new ModelCallError("invalid_output");

  const { mappings, dropped } = validateMapperOutput(parsed.data, {
    context: input.context,
    graph: input.graph,
    config,
  });
  return {
    mappings,
    dropped,
    call: {
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      durationMs: result.durationMs,
    },
    skippedReason: null,
  };
}
