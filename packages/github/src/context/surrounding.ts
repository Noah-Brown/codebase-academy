import type { ContextWindow, Hunk } from "./schema";

/** Split file text into lines; a trailing newline does not produce an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** New-side line range each hunk touches (a pure deletion anchors at its new-side position). */
export function changedRanges(hunks: readonly Hunk[]): Array<[number, number]> {
  return hunks.map((hunk) => {
    const start = Math.max(1, hunk.newStart);
    return [start, Math.max(start, hunk.newStart + hunk.newLines - 1)];
  });
}

/**
 * Windows of ±`radius` lines around each hunk's new-side range, clipped to the file and with
 * overlapping or adjacent windows merged. Line numbers are 1-based and inclusive.
 */
export function surroundingWindows(
  fileText: string,
  hunks: readonly Hunk[],
  radius: number,
): ContextWindow[] {
  const lines = splitLines(fileText);
  if (lines.length === 0) return [];
  const ranges = changedRanges(hunks)
    .map(([start, end]): [number, number] => [
      Math.max(1, start - radius),
      Math.min(lines.length, end + radius),
    ])
    .filter(([start, end]) => start <= end)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged.map(([startLine, endLine]) => ({
    startLine,
    endLine,
    text: lines.slice(startLine - 1, endLine).join("\n"),
  }));
}
