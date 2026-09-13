import { describe, expect, it } from "vitest";
import { CurriculumGraph, validateCurriculum } from "./graph";
import { buildCurriculum, getCurriculum } from "./load";
import { curriculumConceptSchema, type Curriculum, type CurriculumConcept } from "./schema";

function concept(id: string, overrides: Partial<CurriculumConcept> = {}): CurriculumConcept {
  return {
    id,
    title: id,
    domain: id.split(".")[0]!,
    summary: "summary",
    difficulty: 2,
    operationalImportance: 0.5,
    prerequisites: [],
    learningObjectives: ["objective"],
    recognitionSignals: ["signal"],
    misconceptionPatterns: ["misconception"],
    assessmentModes: ["explain"],
    tags: [],
    version: 1,
    ...overrides,
  };
}

function curriculumOf(concepts: CurriculumConcept[]): Curriculum {
  return {
    version: 1,
    domains: [
      { id: "a", title: "A", summary: "A", order: 0 },
      { id: "b", title: "B", summary: "B", order: 1 },
    ],
    concepts,
  };
}

const codes = (c: Curriculum) => validateCurriculum(c).map((issue) => issue.code);

describe("seed curriculum", () => {
  const { curriculum, graph, warnings } = getCurriculum();

  it("loads with no validation errors or warnings", () => {
    expect(validateCurriculum(curriculum)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("is intentionally small but covers all seven MVP domains", () => {
    expect(curriculum.concepts.length).toBeGreaterThanOrEqual(30);
    expect(curriculum.concepts.length).toBeLessThanOrEqual(60);
    expect(curriculum.domains.map((d) => d.id).sort()).toEqual(
      ["db", "dsa", "fundamentals", "reliability", "security", "systems", "web"].sort(),
    );
    for (const domain of curriculum.domains) {
      expect(graph.conceptsInDomain(domain.id).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("encodes the async → backpressure prerequisite chain from the brief", () => {
    const chain = [
      "fundamentals.functions",
      "fundamentals.async-basics",
      "systems.concurrency",
      "systems.bounded-concurrency",
      "systems.backpressure",
    ];
    for (let i = 1; i < chain.length; i++) {
      // A path, not necessarily a direct edge: redundant direct edges are disallowed (D18).
      expect(graph.allPrerequisites(chain[i]!).map((c) => c.id)).toContain(chain[i - 1]);
    }
  });

  it("contains the concepts needed by the golden PR fixtures", () => {
    for (const id of [
      "web.retries",
      "web.idempotency",
      "db.transactions",
      "systems.bounded-concurrency",
      "web.authn-vs-authz",
      "db.indexes",
      "db.migrations",
    ]) {
      expect(graph.has(id), id).toBe(true);
    }
  });

  it("has a topological order that respects every prerequisite", () => {
    const order = graph.topologicalOrder().map((c) => c.id);
    const position = new Map(order.map((id, index) => [id, index]));
    expect(order).toHaveLength(curriculum.concepts.length);
    for (const c of curriculum.concepts) {
      for (const prerequisite of c.prerequisites) {
        expect(position.get(prerequisite)!).toBeLessThan(position.get(c.id)!);
      }
    }
  });
});

describe("validateCurriculum", () => {
  it("accepts a well-formed graph", () => {
    expect(
      codes(curriculumOf([concept("a.one"), concept("b.two", { prerequisites: ["a.one"] })])),
    ).toEqual([]);
  });

  it("detects duplicate concept IDs", () => {
    expect(codes(curriculumOf([concept("a.one"), concept("a.one")]))).toContain(
      "duplicate_concept_id",
    );
  });

  it("detects missing, self, and duplicate prerequisites", () => {
    const result = codes(
      curriculumOf([
        concept("a.one", { prerequisites: ["a.ghost"] }),
        concept("a.two", { prerequisites: ["a.two"] }),
        concept("a.three", { prerequisites: ["a.one", "a.one"] }),
      ]),
    );
    expect(result).toContain("missing_prerequisite");
    expect(result).toContain("self_prerequisite");
    expect(result).toContain("duplicate_prerequisite");
  });

  it("detects cycles and reports the path", () => {
    const issues = validateCurriculum(
      curriculumOf([
        concept("a.one", { prerequisites: ["a.three"] }),
        concept("a.two", { prerequisites: ["a.one"] }),
        concept("a.three", { prerequisites: ["a.two"] }),
      ]),
    );
    const cycle = issues.find((issue) => issue.code === "prerequisite_cycle");
    expect(cycle?.severity).toBe("error");
    expect(cycle?.message).toMatch(/a\.one -> a\.three -> a\.two -> a\.one/);
  });

  it("detects unknown domains and ID prefixes that disagree with the domain", () => {
    const result = codes(
      curriculumOf([concept("a.one", { domain: "b" }), concept("zzz.two", { domain: "zzz" })]),
    );
    expect(result).toContain("domain_prefix_mismatch");
    expect(result).toContain("unknown_domain");
  });

  it("warns (not errors) when a prerequisite is harder than its dependent", () => {
    const issues = validateCurriculum(
      curriculumOf([
        concept("a.hard", { difficulty: 5 }),
        concept("b.easy", { difficulty: 1, prerequisites: ["a.hard"] }),
      ]),
    );
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "prerequisite_harder_than_concept" }),
    ]);
  });

  it("errors when a concept version is ahead of the curriculum version", () => {
    expect(codes(curriculumOf([concept("a.one", { version: 2 }), concept("b.two")]))).toContain(
      "concept_version_ahead",
    );
  });
});

describe("concept schema", () => {
  it("rejects malformed concepts", () => {
    expect(curriculumConceptSchema.safeParse(concept("NoDomain")).success).toBe(false);
    expect(curriculumConceptSchema.safeParse({ ...concept("a.one"), difficulty: 6 }).success).toBe(
      false,
    );
    expect(
      curriculumConceptSchema.safeParse({ ...concept("a.one"), assessmentModes: ["guess"] })
        .success,
    ).toBe(false);
    expect(curriculumConceptSchema.safeParse({ ...concept("a.one"), extra: true }).success).toBe(
      false,
    );
    expect(
      curriculumConceptSchema.safeParse({ ...concept("a.one"), learningObjectives: [] }).success,
    ).toBe(false);
  });

  it("names the offending file when building from authored files", () => {
    expect(() =>
      buildCurriculum(1, [{ name: "broken.json", data: { domain: {}, concepts: [] } }]),
    ).toThrow(/broken\.json/);
  });
});

describe("CurriculumGraph", () => {
  const graph = new CurriculumGraph(
    curriculumOf([
      concept("a.root"),
      concept("a.mid", { prerequisites: ["a.root"] }),
      concept("b.leaf", { prerequisites: ["a.mid", "a.root"] }),
    ]),
  );

  it("walks transitive prerequisites nearest-first without duplicates", () => {
    expect(graph.allPrerequisites("b.leaf").map((c) => c.id)).toEqual(["a.mid", "a.root"]);
  });

  it("finds direct dependents", () => {
    expect(
      graph
        .directDependents("a.root")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["a.mid", "b.leaf"]);
  });

  it("throws on unknown IDs from require()", () => {
    expect(() => graph.require("a.nope")).toThrow(/Unknown curriculum concept/);
  });
});

describe("related concepts", () => {
  it("accepts related concepts with boundaries and keeps them out of the prerequisite graph", () => {
    const c = curriculumOf([
      concept("a.one", { related: [{ id: "b.two", boundary: "b.two owns X" }] }),
      concept("b.two", { related: [{ id: "a.one", boundary: "a.one owns Y" }] }),
    ]);
    expect(validateCurriculum(c)).toEqual([]);
    expect(new CurriculumGraph(c).topologicalOrder()).toHaveLength(2);
  });

  it("rejects unknown, self, and duplicate related entries", () => {
    const result = codes(
      curriculumOf([
        concept("a.one", {
          related: [
            { id: "a.ghost", boundary: "x" },
            { id: "a.one", boundary: "x" },
          ],
        }),
        concept("b.two", {
          related: [
            { id: "a.one", boundary: "x" },
            { id: "a.one", boundary: "y" },
          ],
        }),
      ]),
    );
    expect(result).toEqual(
      expect.arrayContaining(["missing_related", "self_related", "duplicate_related"]),
    );
  });

  it("warns when a related concept is already a prerequisite", () => {
    const issues = validateCurriculum(
      curriculumOf([
        concept("a.one"),
        concept("b.two", { prerequisites: ["a.one"], related: [{ id: "a.one", boundary: "x" }] }),
      ]),
    );
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "related_is_prerequisite" }),
    ]);
  });
});

describe("redundant prerequisite edges", () => {
  it("warns when a direct prerequisite is already implied through another", () => {
    const issues = validateCurriculum(
      curriculumOf([
        concept("a.root"),
        concept("a.mid", { prerequisites: ["a.root"] }),
        concept("b.leaf", { prerequisites: ["a.mid", "a.root"] }),
      ]),
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "redundant_transitive_prerequisite",
        conceptId: "b.leaf",
      }),
    ]);
  });
});
