import { getCurriculum } from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import { defaultConceptMapperConfig } from "./config";
import { contextFor, fileFrom, lines, skippedFile } from "./golden/context";
import type { MapperOutput } from "./schema";
import { emptyDropCounts, validateMapperOutput } from "./validate";

const { graph } = getCurriculum();

const context = contextFor({
  title: "Sum prices",
  files: [
    fileFrom({
      path: "src/cart/total.ts",
      patch: lines(
        "@@ -3,3 +3,4 @@",
        " export function total(items: Item[]) {",
        "-  return items.length;",
        "+  const sum = items.reduce((acc, item) => acc + item.price, 0);",
        "+  return sum;",
        " }",
      ),
      window: lines(
        "// Cart helpers",
        "",
        "export function total(items: Item[]) {",
        "  const sum = items.reduce((acc, item) => acc + item.price, 0);",
        "  return sum;",
        "}",
      ),
    }),
    skippedFile("package-lock.json", "lockfile"),
  ],
});

type Mapping = MapperOutput["mappings"][number];
type Evidence = Mapping["evidence"][number];

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  path: "src/cart/total.ts",
  excerpt: "const sum = items.reduce((acc, item) => acc + item.price, 0);",
  rationale: "Prices are folded into a running sum.",
  ...overrides,
});

const mapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  conceptId: "dsa.arrays-and-lists",
  relevance: 0.8,
  significance: 0.6,
  suggestedDepth: "applied",
  evidence: [evidence()],
  ...overrides,
});

const validate = (mappings: Mapping[], config = defaultConceptMapperConfig) =>
  validateMapperOutput({ mappings }, { context, graph, config });

describe("validateMapperOutput", () => {
  it("keeps a grounded mapping for a curriculum concept", () => {
    const result = validate([mapping()]);
    expect(result.mappings).toEqual([
      {
        conceptId: "dsa.arrays-and-lists",
        relevance: 0.8,
        significance: 0.6,
        suggestedDepth: "applied",
        evidence: [evidence()],
      },
    ]);
    expect(result.dropped).toEqual(emptyDropCounts());
  });

  it("rejects concept IDs outside the curriculum", () => {
    const result = validate([mapping({ conceptId: "dsa.array-reduction" })]);
    expect(result.mappings).toEqual([]);
    expect(result.dropped.unknown_concept).toBe(1);
  });

  it("rejects scores outside 0..1", () => {
    const result = validate([mapping({ relevance: 1.2 }), mapping({ significance: -0.1 })]);
    expect(result.mappings).toEqual([]);
    expect(result.dropped.invalid_score).toBe(2);
  });

  it("keeps the first mapping for a concept and drops duplicates", () => {
    const result = validate([mapping({ relevance: 0.5 }), mapping({ relevance: 0.9 })]);
    expect(result.mappings.map((m) => m.relevance)).toEqual([0.5]);
    expect(result.dropped.duplicate_concept).toBe(1);
  });

  it("drops evidence from paths the model was not shown", () => {
    const result = validate([
      mapping({
        evidence: [
          evidence({ path: "package-lock.json" }),
          evidence({ path: "src/cart/discounts.ts" }),
        ],
      }),
    ]);
    expect(result.mappings).toEqual([]);
    expect(result.dropped.unknown_path).toBe(2);
    expect(result.dropped.no_valid_evidence).toBe(1);
  });

  it("drops fabricated, vague, and unexplained evidence but keeps the mapping if any survives", () => {
    const result = validate([
      mapping({
        evidence: [
          evidence({ excerpt: "const total = sum(items.map((item) => item.price));" }),
          evidence({ excerpt: "  }  " }),
          evidence({ excerpt: "x".repeat(defaultConceptMapperConfig.maxExcerptChars + 1) }),
          evidence({ rationale: "   " }),
          evidence(),
        ],
      }),
    ]);
    expect(result.mappings[0]!.evidence).toEqual([evidence()]);
    expect(result.dropped).toMatchObject({
      excerpt_not_found: 1,
      invalid_excerpt: 2,
      missing_rationale: 1,
      no_valid_evidence: 0,
    });
  });

  it("removes line numbers outside the shown ranges but keeps the evidence", () => {
    const result = validate([
      mapping({
        evidence: [
          evidence({ startLine: 4, endLine: 4 }),
          evidence({ startLine: 40, endLine: 44 }),
          evidence({ endLine: 5 }),
        ],
      }),
    ]);
    const cited = result.mappings[0]!.evidence;
    expect(cited[0]).toMatchObject({ startLine: 4, endLine: 4 });
    expect(cited[1]).not.toHaveProperty("startLine");
    expect(cited[2]).toMatchObject({ startLine: 5, endLine: 5 });
    expect(result.dropped.line_numbers_removed).toBe(1);
  });

  it("strips line-number prefixes and outer blank lines from stored excerpts", () => {
    const result = validate([
      mapping({
        evidence: [
          evidence({
            excerpt:
              "\n4|   const sum = items.reduce((acc, item) => acc + item.price, 0);\n5|   return sum;\n",
          }),
        ],
      }),
    ]);
    expect(result.mappings[0]!.evidence[0]!.excerpt).toBe(
      "  const sum = items.reduce((acc, item) => acc + item.price, 0);\n  return sum;",
    );
  });

  it("truncates long rationales", () => {
    const config = { ...defaultConceptMapperConfig, maxRationaleChars: 20 };
    const result = validate(
      [mapping({ evidence: [evidence({ rationale: "a".repeat(50) })] })],
      config,
    );
    const rationale = result.mappings[0]!.evidence[0]!.rationale;
    expect(rationale).toHaveLength(20);
    expect(rationale.endsWith("…")).toBe(true);
  });

  it("caps evidence per mapping and mappings per run, best first", () => {
    const config = { ...defaultConceptMapperConfig, maxMappings: 2, maxEvidencePerMapping: 1 };
    const result = validate(
      [
        mapping({ conceptId: "dsa.arrays-and-lists", relevance: 0.5, significance: 0.5 }),
        mapping({ conceptId: "fundamentals.functions", relevance: 0.9, significance: 0.9 }),
        mapping({
          conceptId: "fundamentals.control-flow",
          relevance: 0.7,
          significance: 0.7,
          evidence: [evidence(), evidence({ excerpt: "return sum;" })],
        }),
      ],
      config,
    );
    expect(result.mappings.map((m) => m.conceptId)).toEqual([
      "fundamentals.functions",
      "fundamentals.control-flow",
    ]);
    expect(result.dropped.over_limit).toBe(1);
    expect(result.dropped.evidence_over_limit).toBe(1);
  });
});
