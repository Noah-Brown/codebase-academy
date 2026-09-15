import type { AnalysisContext } from "@academy/github";

/**
 * Grounding checks for model-cited evidence. An excerpt counts only if it appears in the code the
 * model was shown for that path, so fabricated or paraphrased "evidence" is dropped.
 */
export interface GroundingSource {
  path: string;
  /** Normalized, non-empty line sequences an excerpt may be quoted from. */
  sequences: string[][];
  /** Head-file line ranges the model saw, from hunks and surrounding windows. */
  lineRanges: Array<readonly [number, number]>;
}

/** Collapses runs of whitespace so re-indented or re-wrapped quotes still match. */
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** The `N| ` prefix the prompt puts on surrounding lines. */
export const LINE_NUMBER_PREFIX = /^\s*\d+\| ?/;

const splitLines = (text: string) => text.split(/\r?\n/);
const nonEmpty = (lines: string[]) => lines.map(normalizeLine).filter((line) => line.length > 0);

/** Patch lines three ways: in order, head side (context + added), base side (context + removed). */
function patchSequences(patch: string): string[][] {
  const all: string[] = [];
  const head: string[] = [];
  const base: string[] = [];
  for (const line of splitLines(patch)) {
    // Hunk headers, "\ No newline at end of file", and truncation markers are not code.
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    const marker = line[0];
    const text = marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line;
    all.push(text);
    if (marker !== "-") head.push(text);
    if (marker !== "+") base.push(text);
  }
  return [nonEmpty(all), nonEmpty(head), nonEmpty(base)];
}

export function groundingSources(context: AnalysisContext): Map<string, GroundingSource> {
  const sources = new Map<string, GroundingSource>();
  for (const file of context.files) {
    if (!file.included) continue;
    sources.set(file.path, {
      path: file.path,
      sequences: [
        ...(file.patch ? patchSequences(file.patch) : []),
        ...file.context.map((window) => nonEmpty(splitLines(window.text))),
      ],
      lineRanges: [
        ...file.hunks
          .filter((hunk) => hunk.newLines > 0)
          .map((hunk) => [hunk.newStart, hunk.newStart + hunk.newLines - 1] as const),
        ...file.context.map((window) => [window.startLine, window.endLine] as const),
      ],
    });
  }
  for (const manifest of context.manifests) {
    if (sources.has(manifest.path)) continue;
    sources.set(manifest.path, {
      path: manifest.path,
      sequences: [nonEmpty(splitLines(manifest.excerpt))],
      lineRanges: [],
    });
  }
  return sources;
}

/** Ways a quoted line may legitimately differ from the source: a copied line number or diff marker. */
function lineVariants(line: string): string[] {
  const withoutNumber = line.replace(LINE_NUMBER_PREFIX, "");
  const variants = [line, withoutNumber, ...[line, withoutNumber].map(stripDiffMarker)].map(
    normalizeLine,
  );
  return [...new Set(variants)].filter((variant) => variant.length > 0);
}

const stripDiffMarker = (line: string) => (/^[+-]/.test(line) ? line.slice(1) : line);

/**
 * True when the excerpt's lines appear consecutively in one source sequence. A one-line excerpt may
 * be part of a line; in longer excerpts the first and last lines may be partial.
 */
export function excerptAppearsIn(source: GroundingSource, excerpt: string): boolean {
  const quote = splitLines(excerpt)
    .map(lineVariants)
    .filter((variants) => variants.length > 0);
  if (quote.length === 0) return false;
  return source.sequences.some((sequence) => containsQuote(sequence, quote));
}

function containsQuote(sequence: string[], quote: string[][]): boolean {
  const last = quote.length - 1;
  for (let start = 0; start + last < sequence.length; start++) {
    let matched = true;
    for (let offset = 0; offset <= last && matched; offset++) {
      const actual = sequence[start + offset]!;
      matched = quote[offset]!.some((variant) => {
        if (last === 0) return actual.includes(variant);
        if (offset === 0) return actual.endsWith(variant);
        if (offset === last) return actual.startsWith(variant);
        return actual === variant;
      });
    }
    if (matched) return true;
  }
  return false;
}

export function lineRangeIsGrounded(
  source: GroundingSource,
  startLine: number,
  endLine: number,
): boolean {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return false;
  if (startLine < 1 || endLine < startLine) return false;
  return source.lineRanges.some(([from, to]) => startLine >= from && endLine <= to);
}
