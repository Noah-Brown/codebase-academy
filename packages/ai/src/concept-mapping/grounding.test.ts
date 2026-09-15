import { describe, expect, it } from "vitest";
import { contextFor, fileFrom, lines, skippedFile } from "./golden/context";
import {
  excerptAppearsIn,
  groundingSources,
  lineRangeIsGrounded,
  normalizeLine,
} from "./grounding";

const file = fileFrom({
  path: "src/cart/total.ts",
  patch: lines(
    "@@ -3,3 +3,4 @@",
    " export function total(items: Item[]) {",
    "-  return items.length;",
    "+  const sum = items.reduce((acc, item) => acc + item.price, 0);",
    "+  return sum;",
    " }",
    "\\ No newline at end of file",
  ),
  window: lines(
    "// Cart helpers",
    "",
    "export function total(items: Item[]) {",
    "  const sum = items.reduce((acc, item) => acc + item.price, 0);",
    "  return sum;",
    "}",
  ),
});
const context = contextFor({
  title: "Sum prices",
  files: [file, skippedFile("package-lock.json", "lockfile")],
  manifests: [{ path: "package.json", excerpt: lines("{", '  "name": "cart-service"', "}") }],
});
const sources = groundingSources(context);
const source = sources.get("src/cart/total.ts")!;

describe("groundingSources", () => {
  it("covers included files and manifests, never skipped files", () => {
    expect([...sources.keys()].sort()).toEqual(["package.json", "src/cart/total.ts"]);
  });

  it("records the head-file ranges from hunks and surrounding windows", () => {
    expect(source.lineRanges).toEqual([
      [3, 6],
      [1, 6],
    ]);
  });
});

describe("excerptAppearsIn", () => {
  it("normalizes whitespace", () => {
    expect(normalizeLine("  const   sum =\titems ")).toBe("const sum = items");
  });

  it("accepts part of a single line", () => {
    expect(excerptAppearsIn(source, "items.reduce((acc, item) => acc + item.price, 0)")).toBe(true);
  });

  it("accepts consecutive lines with different indentation and partial ends", () => {
    expect(
      excerptAppearsIn(
        source,
        "sum = items.reduce((acc, item) => acc + item.price, 0);\n        return sum;",
      ),
    ).toBe(true);
  });

  it("accepts copied diff markers and line-number prefixes", () => {
    expect(
      excerptAppearsIn(
        source,
        "+  const sum = items.reduce((acc, item) => acc + item.price, 0);\n+  return sum;",
      ),
    ).toBe(true);
    expect(
      excerptAppearsIn(
        source,
        "4|   const sum = items.reduce((acc, item) => acc + item.price, 0);\n5|   return sum;",
      ),
    ).toBe(true);
  });

  it("accepts removed lines, which are part of the change", () => {
    expect(excerptAppearsIn(source, "return items.length;")).toBe(true);
  });

  it("accepts manifest excerpts", () => {
    expect(excerptAppearsIn(sources.get("package.json")!, '"name": "cart-service"')).toBe(true);
  });

  it("rejects paraphrases, reordered lines, and patch metadata", () => {
    expect(excerptAppearsIn(source, "return items.reduce(sum);")).toBe(false);
    expect(
      excerptAppearsIn(
        source,
        "return sum;\nconst sum = items.reduce((acc, item) => acc + item.price, 0);",
      ),
    ).toBe(false);
    expect(excerptAppearsIn(source, "No newline at end of file")).toBe(false);
    expect(excerptAppearsIn(source, "@@ -3,3 +3,4 @@")).toBe(false);
    expect(excerptAppearsIn(source, "   \n  ")).toBe(false);
  });
});

describe("lineRangeIsGrounded", () => {
  it("accepts ranges inside what the model saw", () => {
    expect(lineRangeIsGrounded(source, 3, 6)).toBe(true);
    expect(lineRangeIsGrounded(source, 1, 1)).toBe(true);
  });

  it("rejects ranges outside it, and malformed ranges", () => {
    expect(lineRangeIsGrounded(source, 6, 7)).toBe(false);
    expect(lineRangeIsGrounded(source, 0, 2)).toBe(false);
    expect(lineRangeIsGrounded(source, 5, 4)).toBe(false);
    expect(lineRangeIsGrounded(source, 2.5, 3)).toBe(false);
    expect(lineRangeIsGrounded(sources.get("package.json")!, 1, 1)).toBe(false);
  });
});
