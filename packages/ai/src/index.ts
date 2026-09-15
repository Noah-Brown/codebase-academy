/**
 * AI boundary (Milestone 3).
 *
 * The only package that talks to model providers. Exposes narrow, versioned,
 * schema-validated operations and owns no business state. Repository content is
 * always untrusted input.
 */
export {
  emptyUsage,
  MODEL_ERROR_CODES,
  ModelCallError,
  type ModelErrorCode,
  type ModelUsage,
  type StructuredModel,
  type StructuredRequest,
  type StructuredResult,
} from "./model";
export { MAPPER_VERSION } from "./versions";

export {
  CLAUDE_CLI_ENV_ALLOWLIST,
  CLAUDE_EFFORTS,
  claudeCliArgs,
  claudeCliEnv,
  createClaudeCliModel,
  interpretClaudeCliOutput,
  type ClaudeCliModelOptions,
  type ClaudeEffort,
  type SpawnProcess,
} from "./providers/claude-cli";
export {
  anthropicErrorCode,
  createAnthropicModel,
  type AnthropicEffort,
  type AnthropicMessagesClient,
  type AnthropicModelOptions,
} from "./providers/anthropic";
export {
  createStructuredModel,
  MODEL_PROVIDERS,
  type ModelProvider,
  type ModelProviderConfig,
} from "./providers/create";

export { defaultConceptMapperConfig, type ConceptMapperConfig } from "./concept-mapping/config";
export {
  excerptAppearsIn,
  groundingSources,
  lineRangeIsGrounded,
  normalizeLine,
  type GroundingSource,
} from "./concept-mapping/grounding";
export {
  mapConcepts,
  type ConceptMappingCall,
  type ConceptMappingResult,
} from "./concept-mapping/mapper";
export {
  buildConceptMapperPrompt,
  buildConceptMapperSystemPrompt,
  type ConceptMapperPrompt,
} from "./concept-mapping/prompt";
export {
  mapperOutputJsonSchema,
  mapperOutputSchema,
  type MapperOutput,
} from "./concept-mapping/schema";
export {
  DROP_REASONS,
  emptyDropCounts,
  validateMapperOutput,
  type DropCounts,
  type DropReason,
  type ValidatedMapping,
} from "./concept-mapping/validate";
