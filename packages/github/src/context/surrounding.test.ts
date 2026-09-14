import { describe, expect, it } from "vitest";
import type { Hunk } from "./schema";
import { splitLines, surroundingWindows } from "./surrounding";

const FILE = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const hunk = (newStart: number, newLines: number): Hunk => ({
  oldStart: newStart,
  oldLines: newLines,
  newStart,
  newLines,
});

describe("surroundingWindows", () => {
  it("adds the radius on both sides of a hunk", () => {
    const [window] = surroundingWindows(FILE, [hunk(50, 3)], 5);
    expect(window).toMatchObject({ startLine: 45, endLine: 57 });
    expect(window?.text.split("\n")).toHaveLength(13);
    expect(window?.text.startsWith("line 45\n")).toBe(true);
    expect(window?.text.endsWith("line 57")).toBe(true);
  });

  it("clips to the file bounds", () => {
    const windows = surroundingWindows(FILE, [hunk(2, 2), hunk(98, 5)], 10);
    expect(windows.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [1, 13],
      [88, 100],
    ]);
  });

  it("merges overlapping and adjacent windows, regardless of hunk order", () => {
    const windows = surroundingWindows(
      FILE,
      [hunk(40, 1), hunk(10, 2), hunk(20, 1), hunk(31, 1)],
      4,
    );
    // 10-11 → 6-15; 20 → 16-24 (adjacent, merged); 31 → 27-35; 40 → 36-44 (adjacent, merged).
    expect(windows.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [6, 24],
      [27, 44],
    ]);
    expect(windows[0]?.text.split("\n")).toHaveLength(19);
  });

  it("anchors a pure deletion at its new-side position", () => {
    const windows = surroundingWindows(FILE, [hunk(30, 0)], 2);
    expect(windows.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([[28, 32]]);
    expect(surroundingWindows(FILE, [hunk(0, 0)], 1)[0]).toMatchObject({
      startLine: 1,
      endLine: 2,
    });
  });

  it("returns hunk lines only for radius 0 and nothing for empty files or hunks past the end", () => {
    expect(surroundingWindows(FILE, [hunk(5, 2)], 0)).toEqual([
      { startLine: 5, endLine: 6, text: "line 5\nline 6" },
    ]);
    expect(surroundingWindows("", [hunk(1, 1)], 3)).toEqual([]);
    expect(surroundingWindows(FILE, [hunk(500, 3)], 3)).toEqual([]);
    expect(surroundingWindows(FILE, [], 3)).toEqual([]);
  });
});

describe("splitLines", () => {
  it("ignores one trailing newline and handles CRLF", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});
