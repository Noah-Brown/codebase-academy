import type { Hunk } from "./schema";
import { estimateTokens } from "./tokens";

/**
 * GitHub's per-file `patch` is a unified diff without file headers. Hunk headers are read
 * directly: every content line starts with `+`, `-`, space, or `\`, so a line starting with
 * `@@` is always a header. (parse-diff was evaluated but mis-parses hunks containing lines
 * such as `--- comment`, which are ordinary removed `-- comment` lines.)
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * When a file's first hunk alone exceeds its budget, at least this many body lines must fit for
 * the file to be included as a slice; otherwise it is omitted.
 */
export const MIN_HUNK_SLICE_LINES = 20;

/** Appended after a hunk cut at a line boundary. Starts with `\` so diff readers skip it. */
export function truncationMarkerLine(droppedLines: number): string {
  return `\\ … truncated ${droppedLines} lines (budget)`;
}

export interface PatchSegment {
  /** `null` for text before the first hunk header (not expected from GitHub). */
  hunk: Hunk | null;
  text: string;
}

export function splitPatch(patch: string): PatchSegment[] {
  if (patch === "") return [];
  const segments: Array<{ hunk: Hunk | null; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      segments.push({
        hunk: {
          oldStart: Number(header[1]),
          oldLines: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newLines: header[4] === undefined ? 1 : Number(header[4]),
        },
        lines: [line],
      });
    } else if (segments.length === 0) {
      segments.push({ hunk: null, lines: [line] });
    } else {
      (segments.at(-1) as { lines: string[] }).lines.push(line);
    }
  }
  return segments.map(({ hunk, lines }) => ({ hunk, text: lines.join("\n") }));
}

export function parsePatchHunks(patch: string): Hunk[] {
  return splitPatch(patch).flatMap((segment) => (segment.hunk ? [segment.hunk] : []));
}

export interface TruncatedPatch {
  /** Empty when not even a minimal slice of the first hunk fits. */
  patch: string;
  /** Ranges of the hunks in `patch`; a sliced hunk describes only the lines kept. */
  hunks: Hunk[];
  truncated: boolean;
  tokens: number;
}

/**
 * Cut one hunk at a line boundary so the result fits `maxChars`: the header is rewritten with the
 * kept line counts (section heading preserved) and a marker line records how many lines were
 * dropped. Returns `null` when fewer than `MIN_HUNK_SLICE_LINES` body lines would fit.
 */
function sliceHunk(segment: PatchSegment, maxChars: number): PatchSegment | null {
  const start = segment.hunk;
  if (!start) return null;
  const [headerLine = "", ...body] = segment.text.split("\n");
  if (body.length <= MIN_HUNK_SLICE_LINES) return null;
  const headerMatch = HUNK_HEADER.exec(headerLine);
  const section = headerMatch ? headerLine.slice(headerMatch[0].length) : "";

  let oldLines = 0;
  let newLines = 0;
  let bodyChars = 0;
  let best: { kept: number; hunk: Hunk } | null = null;
  for (let kept = 1; kept < body.length; kept += 1) {
    const prefix = (body[kept - 1] as string)[0];
    if (prefix === "+") newLines += 1;
    else if (prefix === "-") oldLines += 1;
    else if (prefix !== "\\") {
      oldLines += 1;
      newLines += 1;
    }
    bodyChars += (body[kept - 1] as string).length + 1;
    if (kept < MIN_HUNK_SLICE_LINES) continue;

    const hunk: Hunk = { ...start, oldLines, newLines };
    const header = `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@${section}`;
    // header + (newline + line) per kept line + newline + marker
    const total = header.length + bodyChars + 1 + truncationMarkerLine(body.length - kept).length;
    if (total > maxChars) break;
    best = { kept, hunk };
  }
  if (!best) return null;

  const { kept, hunk } = best;
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}`;
  return {
    hunk,
    text: [header, ...body.slice(0, kept), truncationMarkerLine(body.length - kept)].join("\n"),
  };
}

/**
 * Keep whole hunks, in order, while the joined patch stays within `maxTokens`. If not even the
 * first hunk fits, keep a line-boundary slice of it (see `sliceHunk`).
 */
export function truncatePatch(patch: string, maxTokens: number): TruncatedPatch {
  const segments = splitPatch(patch);
  const maxChars = Math.max(0, maxTokens) * 4;
  const kept: PatchSegment[] = [];
  let chars = 0;
  let sliced = false;
  for (const segment of segments) {
    const nextChars = chars + (kept.length > 0 ? 1 : 0) + segment.text.length;
    if (nextChars <= maxChars) {
      kept.push(segment);
      chars = nextChars;
      continue;
    }
    if (kept.length === 0) {
      const slice = sliceHunk(segment, maxChars);
      if (slice) {
        kept.push(slice);
        sliced = true;
      }
    }
    break;
  }
  const text = kept.map((segment) => segment.text).join("\n");
  return {
    patch: text,
    hunks: kept.flatMap((segment) => (segment.hunk ? [segment.hunk] : [])),
    truncated: sliced || kept.length < segments.length,
    tokens: estimateTokens(text),
  };
}
