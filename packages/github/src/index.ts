/**
 * GitHub boundary (Milestone 2).
 *
 * Owns GitHub App installations, short-lived installation tokens, pull request
 * metadata, patches, and constrained surrounding context. Nothing outside this
 * package calls the GitHub API directly. No database access.
 */
export {
  createGitHubApp,
  createInstallationTokenCache,
  decodeTextContent,
  MAX_PULL_REQUEST_FILES,
  TOKEN_REFRESH_MARGIN_MS,
  type GitHubAppClient,
  type GitHubAppOptions,
} from "./app";
export { GitHubApiError, isNotFoundError } from "./errors";
export {
  toInstallationRecord,
  toPullRequestRecord,
  toRepositoryRecord,
  type InstallationRecord,
  type PullRequestRecord,
  type RepositoryRecord,
  type WebhookInstallation,
  type WebhookPullRequest,
  type WebhookPullRequestRepository,
} from "./records";
export type * from "./types";
export {
  GITHUB_API_URL,
  listUserInstallations,
  nextPageUrl,
  type ListUserInstallationsOptions,
  type UserInstallation,
} from "./user-installations";
export {
  INSTALLATION_ACTIONS,
  INSTALLATION_REPOSITORIES_ACTIONS,
  PULL_REQUEST_ACTIONS,
  parseWebhookEvent,
  verifyWebhookSignature,
  type IgnoredWebhookEvent,
  type InstallationRepositoriesWebhookEvent,
  type InstallationWebhookEvent,
  type PullRequestWebhookEvent,
  type WebhookEvent,
  type WebhookRepositoryRef,
} from "./webhooks";

export {
  buildAnalysisContext,
  ContextBuildError,
  type BuildAnalysisContextInput,
  type ContextBuildErrorCode,
  type PullRequestContextSource,
} from "./context/build";
export {
  allocatePatches,
  compareFilePriority,
  estimateTokens,
  fitWindows,
  type PatchAllocation,
  type PatchCandidate,
} from "./context/budget";
export {
  BINARY_EXTENSIONS,
  classifySkip,
  fileCategory,
  isTextLikePath,
  LOCKFILES,
  type FileCategory,
} from "./context/classify";
export {
  isManifestPath,
  MANIFEST_NAMES,
  manifestCandidates,
  manifestExcerpt,
} from "./context/manifests";
export {
  MIN_HUNK_SLICE_LINES,
  parsePatchHunks,
  splitPatch,
  truncatePatch,
  truncationMarkerLine,
  type TruncatedPatch,
} from "./context/patch";
export {
  countRedactionMarkers,
  mergeRedactionCounts,
  REDACTION_KINDS,
  redactionMarker,
  redactSecrets,
  type RedactionCounts,
  type RedactionKind,
  type RedactionResult,
} from "./context/redact";
export {
  ANALYZER_VERSION,
  analysisContextSchema,
  contextConfigSchema,
  defaultContextConfig,
  FILE_STATUSES,
  resolveContextConfig,
  SKIP_REASONS,
  type AnalysisContext,
  type AnalysisFile,
  type ContextConfig,
  type ContextWindow,
  type FileStatus,
  type Hunk,
  type SkipReason,
} from "./context/schema";
export { surroundingWindows } from "./context/surrounding";
