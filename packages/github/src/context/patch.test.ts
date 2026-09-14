import { describe, expect, it } from "vitest";
import { parsePatchHunks, splitPatch, truncatePatch } from "./patch";

const HUNK_A = ["@@ -1,3 +1,4 @@ function retry()", " a", "-b", "+c", "+d", " e"].join("\n");
const HUNK_B = ["@@ -20,2 +21,2 @@", " x", "--- comment", "+++ counter", " y"].join("\n");
const HUNK_C = ["@@ -40 +41,0 @@", "-gone"].join("\n");
const PATCH = [HUNK_A, HUNK_B, HUNK_C].join("\n");

describe("parsePatchHunks", () => {
  it("reads every hunk header, including lines that look like file headers", () => {
    expect(parsePatchHunks(PATCH)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
      { oldStart: 20, oldLines: 2, newStart: 21, newLines: 2 },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 0 },
    ]);
  });

  it("handles new files, empty input, and a trailing no-newline marker", () => {
    const added = ["@@ -0,0 +1,2 @@", "+one", "+two", "\\ No newline at end of file"].join("\n");
    expect(parsePatchHunks(added)).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 },
    ]);
    expect(parsePatchHunks("")).toEqual([]);
  });

  it("splits into segments whose text rejoins to the original", () => {
    const segments = splitPatch(PATCH);
    expect(segments.map((segment) => segment.text)).toEqual([HUNK_A, HUNK_B, HUNK_C]);
    expect(segments.map((segment) => segment.text).join("\n")).toBe(PATCH);
  });
});

describe("truncatePatch", () => {
  it("keeps the whole patch when it fits", () => {
    const result = truncatePatch(PATCH, 1_000);
    expect(result).toMatchObject({
      patch: PATCH,
      truncated: false,
      tokens: Math.ceil(PATCH.length / 4),
    });
    expect(result.hunks).toHaveLength(3);
  });

  it("cuts at hunk boundaries", () => {
    const twoHunks = `${HUNK_A}\n${HUNK_B}`;
    const result = truncatePatch(PATCH, Math.ceil(twoHunks.length / 4));
    expect(result.patch).toBe(twoHunks);
    expect(result.truncated).toBe(true);
    expect(result.hunks.map((hunk) => hunk.newStart)).toEqual([1, 21]);
    expect(result.tokens).toBeLessThanOrEqual(Math.ceil(twoHunks.length / 4));
  });

  it("returns an empty patch when the first hunk does not fit", () => {
    expect(truncatePatch(PATCH, 2)).toEqual({ patch: "", hunks: [], truncated: true, tokens: 0 });
    expect(truncatePatch("", 10)).toEqual({ patch: "", hunks: [], truncated: false, tokens: 0 });
  });
});

describe("truncatePatch inside a single hunk", () => {
  const body = Array.from({ length: 100 }, (_, i) =>
    i % 3 === 0 ? `-old ${i}` : i % 3 === 1 ? `+new ${i}` : ` same ${i}`,
  );
  const big = ["@@ -10,67 +10,67 @@ class Retry", ...body].join("\n");

  it("keeps the header, leading lines, and a marker; ranges describe the kept lines", () => {
    const result = truncatePatch(big, 100);
    const lines = result.patch.split("\n");
    const kept = lines.slice(1, -1);
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(100);
    expect(kept.length).toBeGreaterThanOrEqual(20);
    expect(kept).toEqual(body.slice(0, kept.length));
    expect(lines.at(-1)).toBe(`\\ … truncated ${100 - kept.length} lines (budget)`);

    const oldLines = kept.filter((line) => !line.startsWith("+")).length;
    const newLines = kept.filter((line) => !line.startsWith("-")).length;
    expect(result.hunks).toEqual([{ oldStart: 10, oldLines, newStart: 10, newLines }]);
    expect(lines[0]).toBe(`@@ -10,${oldLines} +10,${newLines} @@ class Retry`);
    expect(parsePatchHunks(result.patch)).toEqual(result.hunks);
  });

  it("omits the hunk when not even the header plus 20 lines fits", () => {
    expect(truncatePatch(big, 40)).toEqual({ patch: "", hunks: [], truncated: true, tokens: 0 });
  });

  it("slices only a leading hunk; later hunks are still cut at boundaries", () => {
    const small = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
    const result = truncatePatch(`${small}\n${big}`, 100);
    expect(result).toMatchObject({ patch: small, truncated: true });
  });
});
