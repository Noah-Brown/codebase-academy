import { ANALYZER_VERSION, type AnalysisContext, type AnalysisFile } from "@academy/github";

/** Builders for synthetic analysis contexts: golden fixtures and unit tests. No real repository code. */

export interface FileSpec {
  path: string;
  status?: AnalysisFile["status"];
  /** A unified diff with `@@` hunk headers, as GitHub returns it. */
  patch: string;
  /** Head-file text shown as surrounding lines, starting at `windowStart` (default 1). */
  window?: string;
  windowStart?: number;
}

function parseHunkHeader(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) throw new Error(`Invalid hunk header: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

export function fileFrom(spec: FileSpec): AnalysisFile {
  const lines = spec.patch.split("\n");
  const windowStart = spec.windowStart ?? 1;
  return {
    path: spec.path,
    status: spec.status ?? "modified",
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
    included: true,
    patch: spec.patch,
    patchTruncated: false,
    hunks: lines.filter((line) => line.startsWith("@@")).map(parseHunkHeader),
    context:
      spec.window === undefined
        ? []
        : [
            {
              startLine: windowStart,
              endLine: windowStart + spec.window.split("\n").length - 1,
              text: spec.window,
            },
          ],
    estimatedTokens: Math.ceil((spec.patch.length + (spec.window?.length ?? 0)) / 4),
  };
}

export function skippedFile(path: string, skipReason: NonNullable<AnalysisFile["skipReason"]>) {
  const file: AnalysisFile = {
    path,
    status: "modified",
    additions: 120,
    deletions: 80,
    included: false,
    skipReason,
    patchTruncated: false,
    hunks: [],
    context: [],
    estimatedTokens: 0,
  };
  return file;
}

export function contextFor(input: {
  title: string;
  body?: string;
  files: AnalysisFile[];
  manifests?: AnalysisContext["manifests"];
}): AnalysisContext {
  return {
    analyzerVersion: ANALYZER_VERSION,
    repository: { id: 4242, fullName: "example-org/example-service", defaultBranch: "main" },
    pullRequest: {
      number: 12,
      title: input.title,
      body: input.body ?? "",
      author: "example-dev",
      url: "https://github.com/example-org/example-service/pull/12",
      baseRef: "main",
      headRef: "feature",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    languages: { TypeScript: 120_000 },
    files: input.files,
    manifests: input.manifests ?? [],
    redactions: {},
    budget: {
      maxTotalTokens: 24_000,
      estimatedTokens: input.files.reduce((sum, file) => sum + file.estimatedTokens, 0),
      truncatedFiles: [],
      omittedFiles: [],
    },
    warnings: [],
  };
}

export const lines = (...content: string[]) => content.join("\n");
