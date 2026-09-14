import { CATEGORY_RANK, type FileCategory } from "./classify";
import { truncatePatch } from "./patch";
import type { ContextWindow, FileStatus, Hunk } from "./schema";
import { comparePaths, estimateTokens } from "./tokens";

export { estimateTokens } from "./tokens";

export interface PrioritizedFile {
  path: string;
  category: FileCategory;
  status: FileStatus;
  changes: number;
}

/**
 * Source before tests before docs and config; within a category, larger changes first. Removed
 * files come after surviving ones in the same category (their diff is all deletions). Ties
 * break by path, so the order is total and deterministic.
 */
export function compareFilePriority(a: PrioritizedFile, b: PrioritizedFile): number {
  return (
    CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
    Number(a.status === "removed") - Number(b.status === "removed") ||
    b.changes - a.changes ||
    comparePaths(a.path, b.path)
  );
}

export interface PatchCandidate extends PrioritizedFile {
  /** Redacted patch; `undefined` for metadata-only changes such as a pure rename. */
  patch: string | undefined;
}

export type PatchAllocation =
  | {
      included: true;
      patch: string | undefined;
      hunks: Hunk[];
      truncated: boolean;
      /** Surrounding windows that fit (empty without a `windowsFor` callback). */
      context: ContextWindow[];
      /** At least one surrounding window did not fit. */
      contextDropped: boolean;
      patchTokens: number;
      /** Patch plus context. */
      tokens: number;
    }
  | { included: false };

export interface PatchBudgetLimits {
  maxTotalTokens: number;
  maxFileTokens: number;
  maxFiles: number;
}

export interface PatchAllocationResult {
  /** Candidate paths in priority order. */
  order: string[];
  allocations: Map<string, PatchAllocation>;
  usedTokens: number;
}

/** Surrounding windows for a file given the hunks that survived truncation. */
export type WindowsFor = (path: string, hunks: Hunk[]) => readonly ContextWindow[];

export interface FittedWindows {
  windows: ContextWindow[];
  tokens: number;
  /** At least one window did not fit. */
  dropped: boolean;
}

/** Keep windows in line order while their total stays within `allowance` tokens. */
export function fitWindows(windows: readonly ContextWindow[], allowance: number): FittedWindows {
  const kept: ContextWindow[] = [];
  let tokens = 0;
  let dropped = false;
  for (const window of windows) {
    const cost = estimateTokens(window.text);
    if (tokens + cost <= allowance) {
      kept.push(window);
      tokens += cost;
    } else {
      dropped = true;
    }
  }
  return { windows: kept, tokens, dropped };
}

/**
 * Greedy allocation in priority order. Each file gets up to `maxFileTokens` of what remains: its
 * patch first (truncated at hunk boundaries), then surrounding windows from `windowsFor`. A file
 * whose first hunk does not fit, or beyond `maxFiles`, is omitted; smaller lower-priority files
 * may still fit afterwards.
 *
 * Without `windowsFor` this is a patch-only pass. The files a later pass with windows includes
 * are always a subset of the patch-only pass (budget used only grows), which lets the builder
 * fetch head content just for those.
 */
export function allocatePatches(
  candidates: readonly PatchCandidate[],
  limits: PatchBudgetLimits,
  windowsFor?: WindowsFor,
): PatchAllocationResult {
  const ordered = [...candidates].sort(compareFilePriority);
  const allocations = new Map<string, PatchAllocation>();
  let usedTokens = 0;
  let includedCount = 0;

  for (const candidate of ordered) {
    if (includedCount >= limits.maxFiles) {
      allocations.set(candidate.path, { included: false });
      continue;
    }
    if (candidate.patch === undefined || candidate.patch === "") {
      allocations.set(candidate.path, {
        included: true,
        patch: undefined,
        hunks: [],
        truncated: false,
        context: [],
        contextDropped: false,
        patchTokens: 0,
        tokens: 0,
      });
      includedCount += 1;
      continue;
    }
    const cap = Math.max(0, Math.min(limits.maxFileTokens, limits.maxTotalTokens - usedTokens));
    const truncated = truncatePatch(candidate.patch, cap);
    if (truncated.patch === "") {
      allocations.set(candidate.path, { included: false });
      continue;
    }
    const windows = windowsFor ? windowsFor(candidate.path, truncated.hunks) : [];
    const fitted = fitWindows(windows, cap - truncated.tokens);
    allocations.set(candidate.path, {
      included: true,
      patch: truncated.patch,
      hunks: truncated.hunks,
      truncated: truncated.truncated,
      context: fitted.windows,
      contextDropped: fitted.dropped,
      patchTokens: truncated.tokens,
      tokens: truncated.tokens + fitted.tokens,
    });
    usedTokens += truncated.tokens + fitted.tokens;
    includedCount += 1;
  }

  return { order: ordered.map((candidate) => candidate.path), allocations, usedTokens };
}
