import type {
  DirectoryEntry,
  FileContent,
  PullRequestDetails,
  PullRequestFileList,
} from "../types";
import { allocatePatches, type PatchCandidate } from "./budget";
import { classifySkip, extensionOf, fileCategory } from "./classify";
import { manifestCandidates, manifestExcerpt } from "./manifests";
import {
  countRedactionMarkers,
  mergeRedactionCounts,
  redactSecrets,
  type RedactionCounts,
} from "./redact";
import {
  ANALYZER_VERSION,
  analysisContextSchema,
  resolveContextConfig,
  type AnalysisContext,
  type AnalysisFile,
  type ContextConfig,
  type FileStatus,
  type Hunk,
} from "./schema";
import { splitLines, surroundingWindows } from "./surrounding";
import { comparePaths, estimateTokens, truncateText } from "./tokens";

/** The subset of the GitHub app client the context builder needs. Tests pass a fake. */
export interface PullRequestContextSource {
  getPullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDetails | null>;
  listPullRequestFiles(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestFileList>;
  getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options: { maxBytes: number },
  ): Promise<FileContent | null>;
  /** Optional: lets the builder look up only the root manifests that exist. */
  listDirectory?(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<DirectoryEntry[] | null>;
}

export interface BuildAnalysisContextInput {
  source: PullRequestContextSource;
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  /** When set and the PR head has moved, fail with `head_sha_mismatch` instead of building. */
  expectedHeadSha?: string;
  config?: Partial<ContextConfig>;
}

export type ContextBuildErrorCode = "pull_request_not_found" | "head_sha_mismatch";

export class ContextBuildError extends Error {
  readonly code: ContextBuildErrorCode;

  constructor(code: ContextBuildErrorCode) {
    super(code);
    this.name = "ContextBuildError";
    this.code = code;
  }
}

/** Head content is fetched for these statuses; added files' patches already hold the whole file. */
const CONTEXT_STATUSES: ReadonlySet<FileStatus> = new Set(["modified", "renamed", "changed"]);

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Markers present in the redacted text but not in the raw text. */
function introducedMarkers(raw: string, redacted: string): RedactionCounts {
  const before = countRedactionMarkers(raw);
  const counts: RedactionCounts = {};
  for (const [kind, count] of Object.entries(countRedactionMarkers(redacted))) {
    const added = count - (before[kind] ?? 0);
    if (added > 0) counts[kind] = added;
  }
  return counts;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => comparePaths(a, b)));
}

/**
 * Build the normalized, redacted, budgeted context for one pull request. Deterministic for the
 * same GitHub responses and config. Never logs repository content.
 */
export async function buildAnalysisContext(
  input: BuildAnalysisContextInput,
): Promise<AnalysisContext> {
  const config = resolveContextConfig(input.config);
  const { source, installationId, owner, repo, pullNumber } = input;

  const pr = await source.getPullRequest(installationId, owner, repo, pullNumber);
  if (!pr) throw new ContextBuildError("pull_request_not_found");
  if (input.expectedHeadSha !== undefined && pr.headSha !== input.expectedHeadSha) {
    throw new ContextBuildError("head_sha_mismatch");
  }
  const fileList = await source.listPullRequestFiles(installationId, owner, repo, pullNumber);
  const fetchContent = (path: string) =>
    source.getFileContent(installationId, owner, repo, path, pr.headSha, {
      maxBytes: config.maxFileBytes,
    });

  const redactions: RedactionCounts = {};
  const warnings: string[] = [];
  if (fileList.truncated || pr.changedFiles > fileList.files.length) {
    warnings.push("github_file_list_truncated");
  }

  // Pull request text is always included, so its redactions always count.
  const redactedTitle = redactSecrets(pr.title);
  const redactedBody = redactSecrets(pr.body);
  mergeRedactionCounts(redactions, redactedTitle.counts);
  mergeRedactionCounts(redactions, redactedBody.counts);
  const title = redactedTitle.text;
  const body = truncateText(redactedBody.text, config.maxBodyChars);
  const pullRequestTokens = estimateTokens(title) + estimateTokens(body);

  // 1. Classify every changed file before fetching anything; redact candidate patches.
  const files = [...fileList.files].sort((a, b) => comparePaths(a.path, b.path));
  const planned = files.map((file) => {
    const skipReason = classifySkip(file, config);
    if (skipReason === "no_patch") warnings.push(`patch_omitted:${file.path}`);
    const redacted =
      skipReason === null && file.patch !== undefined
        ? redactSecrets(file.patch, { diff: true })
        : undefined;
    return { file, category: fileCategory(file.path), skipReason, redacted };
  });

  // 2. Manifests present at the head: redacted, excerpted, within their own budget.
  const rootEntries = source.listDirectory
    ? await source.listDirectory(installationId, owner, repo, "", pr.headSha)
    : null;
  const rootNames =
    rootEntries === null
      ? null
      : rootEntries.filter((entry) => entry.type === "file").map((entry) => entry.name);
  const manifestPaths = manifestCandidates(files, rootNames, config.maxManifests);
  const manifestContents = await mapLimit(manifestPaths, config.fetchConcurrency, fetchContent);
  const manifestBudget = Math.min(
    config.maxManifestTokens,
    Math.max(0, config.maxTotalTokens - pullRequestTokens),
  );
  const manifests: AnalysisContext["manifests"] = [];
  let manifestTokens = 0;
  manifestPaths.forEach((path, index) => {
    const content = manifestContents[index];
    if (!content) return;
    const redacted = redactSecrets(content.text);
    const excerpt = manifestExcerpt(redacted.text, config);
    const tokens = estimateTokens(excerpt);
    if (manifestTokens + tokens > manifestBudget) {
      warnings.push(`manifest_omitted:${path}`);
      return;
    }
    mergeRedactionCounts(redactions, redacted.counts);
    manifests.push({ path, excerpt });
    manifestTokens += tokens;
  });

  // 3. Files, in priority order, within what remains.
  const limits = {
    maxTotalTokens: Math.max(0, config.maxTotalTokens - pullRequestTokens - manifestTokens),
    maxFileTokens: config.maxFileTokens,
    maxFiles: config.maxFiles,
  };
  const candidates: PatchCandidate[] = planned
    .filter((entry) => entry.skipReason === null)
    .map((entry) => ({
      path: entry.file.path,
      category: entry.category,
      status: entry.file.status,
      changes: entry.file.changes,
      patch: entry.redacted?.text,
    }));
  const statusByPath = new Map(files.map((file) => [file.path, file.status]));
  const wantsContext = (path: string, hunks: readonly Hunk[]) => {
    const status = statusByPath.get(path);
    return (
      config.contextRadius > 0 &&
      hunks.length > 0 &&
      status !== undefined &&
      CONTEXT_STATUSES.has(status)
    );
  };

  // Pass 1 (patches only) bounds which files can be included, so head content is fetched only
  // for those. Pass 2 re-allocates with surrounding windows; its included set is a subset.
  const patchOnly = allocatePatches(candidates, limits);
  const contextPaths = patchOnly.order.filter((path) => {
    const entry = patchOnly.allocations.get(path);
    return entry?.included === true && wantsContext(path, entry.hunks);
  });
  const contents = await mapLimit(contextPaths, config.fetchConcurrency, fetchContent);
  const rawContent = new Map<string, string>();
  const redactedContent = new Map<string, string>();
  contextPaths.forEach((path, index) => {
    const content = contents[index];
    if (!content) return;
    rawContent.set(path, content.text);
    // Redact the whole file (multi-line secrets can straddle a window edge), then slice.
    redactedContent.set(path, redactSecrets(content.text).text);
  });
  const allocation = allocatePatches(candidates, limits, (path, hunks) => {
    const text = redactedContent.get(path);
    return text === undefined || !wantsContext(path, hunks)
      ? []
      : surroundingWindows(text, hunks, config.contextRadius);
  });

  // 4. Assemble in path order.
  const truncatedFiles: string[] = [];
  const unavailable: string[] = [];
  const outputFiles: AnalysisFile[] = planned.map(({ file, skipReason, redacted }) => {
    const base = {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    };
    const entry = skipReason === null ? allocation.allocations.get(file.path) : undefined;
    if (skipReason !== null || entry === undefined || !entry.included) {
      return {
        ...base,
        included: false,
        skipReason: skipReason ?? "budget",
        patchTruncated: false,
        hunks: [],
        context: [],
        estimatedTokens: 0,
      };
    }

    if (redacted) mergeRedactionCounts(redactions, redacted.counts);
    const raw = rawContent.get(file.path);
    if (raw === undefined && wantsContext(file.path, entry.hunks)) unavailable.push(file.path);
    if (raw !== undefined) {
      const rawLines = splitLines(raw);
      for (const window of entry.context) {
        const rawWindow = rawLines.slice(window.startLine - 1, window.endLine).join("\n");
        mergeRedactionCounts(redactions, introducedMarkers(rawWindow, window.text));
      }
    }
    if (entry.truncated || entry.contextDropped) truncatedFiles.push(file.path);

    return {
      ...base,
      included: true,
      ...(entry.patch !== undefined ? { patch: entry.patch } : {}),
      patchTruncated: entry.truncated,
      hunks: entry.hunks,
      context: entry.context,
      estimatedTokens: entry.tokens,
    };
  });
  for (const path of unavailable) warnings.push(`content_unavailable:${path}`);

  const languages: Record<string, number> = {};
  for (const file of files) {
    const key = extensionOf(file.path) ?? "(none)";
    languages[key] = (languages[key] ?? 0) + 1;
  }

  const context: AnalysisContext = {
    analyzerVersion: ANALYZER_VERSION,
    repository: {
      id: pr.repository.id,
      fullName: pr.repository.fullName,
      defaultBranch: pr.repository.defaultBranch,
    },
    pullRequest: {
      number: pr.number,
      title,
      body,
      author: pr.authorLogin,
      url: pr.htmlUrl,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
    },
    languages: sortedRecord(languages),
    files: outputFiles,
    manifests,
    redactions: sortedRecord(redactions),
    budget: {
      maxTotalTokens: config.maxTotalTokens,
      estimatedTokens: pullRequestTokens + manifestTokens + allocation.usedTokens,
      truncatedFiles,
      omittedFiles: outputFiles
        .filter((file) => file.skipReason === "budget")
        .map((file) => file.path),
    },
    warnings,
  };
  return analysisContextSchema.parse(context);
}
