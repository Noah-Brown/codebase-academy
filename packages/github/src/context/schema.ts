import { z } from "zod";

/**
 * Version of the context-building rules. It is part of the `pr_analyses` idempotency key,
 * so bump it whenever the output for the same pull request could change.
 */
export const ANALYZER_VERSION = "context-v1";

export const FILE_STATUSES = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const SKIP_REASONS = [
  "lockfile",
  "generated",
  "vendored",
  "binary",
  "too_large",
  "no_patch",
  "empty",
  "budget",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

export const hunkSchema = z.strictObject({
  oldStart: nonNegativeInt,
  oldLines: nonNegativeInt,
  newStart: nonNegativeInt,
  newLines: nonNegativeInt,
});
export type Hunk = z.infer<typeof hunkSchema>;

export const contextWindowSchema = z
  .strictObject({ startLine: positiveInt, endLine: positiveInt, text: z.string() })
  .refine((window) => window.endLine >= window.startLine, {
    message: "endLine must not precede startLine",
  });
export type ContextWindow = z.infer<typeof contextWindowSchema>;

export const analysisFileSchema = z
  .strictObject({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum(FILE_STATUSES),
    additions: nonNegativeInt,
    deletions: nonNegativeInt,
    included: z.boolean(),
    skipReason: z.enum(SKIP_REASONS).optional(),
    patch: z.string().optional(),
    patchTruncated: z.boolean(),
    hunks: z.array(hunkSchema),
    context: z.array(contextWindowSchema),
    estimatedTokens: nonNegativeInt,
  })
  .refine((file) => file.included === (file.skipReason === undefined), {
    message: "skipReason is required exactly when a file is not included",
  });
export type AnalysisFile = z.infer<typeof analysisFileSchema>;

export const analysisContextSchema = z.strictObject({
  analyzerVersion: z.string().min(1),
  repository: z.strictObject({
    id: positiveInt,
    fullName: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  pullRequest: z.strictObject({
    number: positiveInt,
    title: z.string(),
    body: z.string(),
    author: z.string(),
    url: z.string(),
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
  }),
  languages: z.record(z.string(), nonNegativeInt),
  files: z.array(analysisFileSchema),
  manifests: z.array(z.strictObject({ path: z.string().min(1), excerpt: z.string() })),
  redactions: z.record(z.string(), nonNegativeInt),
  budget: z.strictObject({
    maxTotalTokens: nonNegativeInt,
    estimatedTokens: nonNegativeInt,
    truncatedFiles: z.array(z.string()),
    omittedFiles: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
});
export type AnalysisContext = z.infer<typeof analysisContextSchema>;

export const contextConfigSchema = z.strictObject({
  /** Budget for everything in the context: PR title and body, manifests, patches, surrounding lines. */
  maxTotalTokens: positiveInt,
  /** Budget for one file's patch plus its surrounding lines. */
  maxFileTokens: positiveInt,
  /** Lines of head content kept on each side of a hunk. 0 disables head-content fetches. */
  contextRadius: nonNegativeInt,
  /** Files that may be included (skipped files do not count). */
  maxFiles: positiveInt,
  maxBodyChars: nonNegativeInt,
  /** A file with more changed lines than this is skipped as `too_large`. */
  maxFileChanges: positiveInt,
  /** A patch longer than this (characters) is skipped as `too_large`. */
  maxPatchChars: positiveInt,
  /** Head content larger than this is not fetched into memory. */
  maxFileBytes: positiveInt,
  maxManifests: nonNegativeInt,
  maxManifestTokens: nonNegativeInt,
  manifestMaxLines: positiveInt,
  manifestMaxChars: positiveInt,
  fetchConcurrency: positiveInt,
});
export type ContextConfig = z.infer<typeof contextConfigSchema>;

export const defaultContextConfig: Readonly<ContextConfig> = Object.freeze({
  maxTotalTokens: 24_000,
  maxFileTokens: 4_000,
  contextRadius: 20,
  maxFiles: 60,
  maxBodyChars: 2_000,
  maxFileChanges: 5_000,
  maxPatchChars: 200_000,
  maxFileBytes: 512 * 1024,
  maxManifests: 8,
  maxManifestTokens: 2_000,
  manifestMaxLines: 60,
  manifestMaxChars: 4_000,
  fetchConcurrency: 4,
});

export function resolveContextConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return contextConfigSchema.parse({ ...defaultContextConfig, ...defined });
}
