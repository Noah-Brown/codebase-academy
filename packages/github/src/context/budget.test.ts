import { describe, expect, it } from "vitest";
import {
  allocatePatches,
  compareFilePriority,
  estimateTokens,
  fitWindows,
  type PatchCandidate,
} from "./budget";

function hunkText(start: number, lines: number): string {
  return [
    `@@ -${start},${lines} +${start},${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => ` line${String(i).padStart(3, "0")}`),
  ].join("\n");
}

function candidate(path: string, overrides: Partial<PatchCandidate> = {}): PatchCandidate {
  return {
    path,
    category: "source",
    status: "modified",
    changes: 10,
    patch: hunkText(1, 10),
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("is ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("compareFilePriority", () => {
  it("orders by category, then removed last, then larger change, then path", () => {
    const files = [
      candidate("docs/guide.md", { category: "docs", changes: 900 }),
      candidate("package.json", { category: "config", changes: 5 }),
      candidate("src/b.test.ts", { category: "test", changes: 50 }),
      candidate("src/old.ts", { status: "removed", changes: 500 }),
      candidate("src/small.ts", { changes: 3 }),
      candidate("src/b.ts", { changes: 40 }),
      candidate("src/a.ts", { changes: 40 }),
    ];
    expect([...files].sort(compareFilePriority).map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/small.ts",
      "src/old.ts",
      "src/b.test.ts",
      "docs/guide.md",
      "package.json",
    ]);
  });
});

describe("allocatePatches", () => {
  const limits = { maxTotalTokens: 200, maxFileTokens: 80, maxFiles: 10 };

  it("is deterministic regardless of input order", () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      candidate(`src/f${i}.ts`, { changes: (i * 7) % 5, patch: hunkText(1, 5 + (i % 4)) }),
    );
    const forward = allocatePatches(files, limits);
    const backward = allocatePatches([...files].reverse(), limits);
    expect(backward.order).toEqual(forward.order);
    expect([...backward.allocations.entries()].sort()).toEqual(
      [...forward.allocations.entries()].sort(),
    );
    expect(forward.usedTokens).toBeLessThanOrEqual(limits.maxTotalTokens);
  });

  it("truncates at hunk boundaries within maxFileTokens", () => {
    const patch = [hunkText(1, 20), hunkText(100, 20), hunkText(200, 20)].join("\n");
    const result = allocatePatches([candidate("src/big.ts", { patch })], limits);
    const allocation = result.allocations.get("src/big.ts");
    expect(allocation).toMatchObject({ included: true, truncated: true });
    if (allocation?.included) {
      expect(allocation.tokens).toBeLessThanOrEqual(limits.maxFileTokens);
      expect(allocation.hunks.length).toBeGreaterThanOrEqual(1);
      expect(allocation.hunks.length).toBeLessThan(3);
    }
  });

  it("omits files that do not fit and still admits smaller later files", () => {
    const result = allocatePatches(
      [
        candidate("src/a.ts", { changes: 30, patch: hunkText(1, 30) }), // ~73 tokens
        candidate("src/b.ts", { changes: 29, patch: hunkText(1, 30) }),
        candidate("src/c.ts", { changes: 28, patch: hunkText(1, 30) }),
        candidate("src/tiny.ts", { changes: 1, patch: hunkText(1, 2) }),
      ],
      { maxTotalTokens: 160, maxFileTokens: 80, maxFiles: 10 },
    );
    expect(result.allocations.get("src/a.ts")?.included).toBe(true);
    expect(result.allocations.get("src/b.ts")?.included).toBe(true);
    expect(result.allocations.get("src/c.ts")?.included).toBe(false);
    expect(result.allocations.get("src/tiny.ts")?.included).toBe(true);
    expect(result.usedTokens).toBeLessThanOrEqual(160);
  });

  it("respects maxFiles, counting metadata-only files", () => {
    const result = allocatePatches(
      [
        candidate("src/a.ts", { changes: 5 }),
        candidate("src/renamed.ts", { changes: 0, patch: undefined }),
        candidate("src/c.ts", { changes: 1 }),
      ],
      { maxTotalTokens: 1_000, maxFileTokens: 500, maxFiles: 2 },
    );
    expect(result.allocations.get("src/a.ts")?.included).toBe(true);
    expect(result.allocations.get("src/c.ts")?.included).toBe(true);
    expect(result.allocations.get("src/renamed.ts")).toEqual({ included: false });
  });
});

describe("fitWindows", () => {
  const window = (startLine: number, chars: number) => ({
    startLine,
    endLine: startLine,
    text: "x".repeat(chars),
  });

  it("keeps windows that fit and flags dropped ones", () => {
    const result = fitWindows([window(1, 40), window(10, 400), window(20, 40)], 25);
    expect(result.windows.map((w) => w.startLine)).toEqual([1, 20]);
    expect(result).toMatchObject({ tokens: 20, dropped: true });
    expect(fitWindows([window(1, 4)], 1)).toMatchObject({ tokens: 1, dropped: false });
  });
});
