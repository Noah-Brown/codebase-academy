import {
  CurriculumGraph,
  getCurriculum,
  type Curriculum,
  type CurriculumConcept,
} from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import { defaultLearningConfig as config, type LearningConfig } from "./config";
import { paymentRetryFixture } from "./fixtures";
import { initialConceptState, replayEvidence, type LearnerConceptState } from "./mastery";
import { createLearnerView, depthFor, selectLesson, type MappedConcept } from "./selection";
import { describeMastery } from "./status";

const NOW = new Date("2026-09-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

function concept(id: string, overrides: Partial<CurriculumConcept> = {}): CurriculumConcept {
  return {
    id,
    title: id,
    domain: "t",
    summary: "s",
    difficulty: 2,
    operationalImportance: 0.5,
    prerequisites: [],
    learningObjectives: ["o"],
    recognitionSignals: ["r"],
    misconceptionPatterns: ["m"],
    assessmentModes: ["explain"],
    tags: [],
    version: 1,
    ...overrides,
  };
}

function graphOf(concepts: CurriculumConcept[]): CurriculumGraph {
  const curriculum: Curriculum = {
    version: 1,
    domains: [{ id: "t", title: "T", summary: "T", order: 0 }],
    concepts,
  };
  return new CurriculumGraph(curriculum);
}

function mapping(conceptId: string, overrides: Partial<MappedConcept> = {}): MappedConcept {
  return {
    conceptId,
    relevance: 0.8,
    significance: 0.5,
    suggestedDepth: "advanced",
    evidence: [{ path: "src/a.ts", excerpt: "doThing()", rationale: "because" }],
    ...overrides,
  };
}

/** A state with strong evidence at the given mean. */
function assessed(conceptId: string, mastery: number, weight = 6): LearnerConceptState {
  return {
    ...initialConceptState(conceptId, 2, "intermediate", config),
    alpha: mastery * 100,
    beta: (1 - mastery) * 100,
    evidenceCount: 5,
    evidenceWeight: weight,
    sessionIds: ["s1", "s2"],
    demonstratedModes: ["explain", "compare"],
  };
}

describe("selectLesson — ranking terms", () => {
  const graph = graphOf([concept("t.a"), concept("t.b")]);
  const learner = createLearnerView("intermediate", graph, []);

  it("prefers the concept more significant to the PR, all else equal", () => {
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [mapping("t.a", { significance: 0.3 }), mapping("t.b", { significance: 0.9 })],
    });
    expect(result.selected?.conceptId).toBe("t.b");
  });

  it("prefers the concept with the larger mastery gap, all else equal", () => {
    const view = createLearnerView("intermediate", graph, [
      assessed("t.a", 0.9),
      assessed("t.b", 0.3),
    ]);
    const result = selectLesson({
      graph,
      learner: view,
      now: NOW,
      mappings: [mapping("t.a"), mapping("t.b")],
    });
    expect(result.selected?.conceptId).toBe("t.b");
  });

  it("returns a breakdown whose weighted terms and penalties sum to the priority", () => {
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [mapping("t.a", { relevance: 0.4 })],
      recentLessons: [{ conceptId: "t.a", completedAt: hoursAgo(1) }],
    });
    const { weighted, basePriority, penalties, priority } = result.ranked[0]!.breakdown;
    const sum = Object.values(weighted).reduce((a, b) => a + b, 0);
    expect(basePriority).toBeCloseTo(sum, 3);
    expect(priority).toBeCloseTo(basePriority - penalties.reduce((a, p) => a + p.amount, 0), 3);
    expect(penalties.map((p) => p.code).sort()).toEqual(["recent_lesson", "weak_evidence"]);
  });

  it("uses the brief's weights exactly", () => {
    const [only] = selectLesson({ graph, learner, now: NOW, mappings: [mapping("t.a")] }).ranked;
    const c = only!.breakdown.components;
    expect(only!.breakdown.basePriority).toBeCloseTo(
      0.35 * c.prSignificance +
        0.25 * c.masteryGap +
        0.2 * c.prerequisiteReadiness +
        0.1 * c.novelty +
        0.1 * c.operationalImportance,
      3,
    );
  });
});

describe("selectLesson — penalties", () => {
  const graph = graphOf([concept("t.a"), concept("t.b")]);
  const learner = createLearnerView("intermediate", graph, []);

  it("penalizes a concept studied within the recent-lesson window only", () => {
    const run = (completedAt: Date) =>
      selectLesson({
        graph,
        learner,
        now: NOW,
        mappings: [mapping("t.a", { significance: 0.6 }), mapping("t.b", { significance: 0.5 })],
        recentLessons: [{ conceptId: "t.a", completedAt }],
      });
    expect(run(hoursAgo(2)).selected?.conceptId).toBe("t.b");
    expect(run(hoursAgo(config.ranking.recentLessonWindowHours + 1)).selected?.conceptId).toBe(
      "t.a",
    );
  });

  it("penalizes weak evidence", () => {
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [
        mapping("t.a", { relevance: 0.35, significance: 0.6 }),
        mapping("t.b", { significance: 0.5 }),
      ],
    });
    expect(result.selected?.conceptId).toBe("t.b");
    expect(result.ranked.find((c) => c.conceptId === "t.a")?.reasons.join(" ")).toMatch(/weak/);
  });

  it("penalizes and reports unmet prerequisites", () => {
    const prereqGraph = graphOf([
      concept("t.base"),
      concept("t.hard", { prerequisites: ["t.base"], difficulty: 3 }),
      concept("t.other"),
    ]);
    const view = createLearnerView("intermediate", prereqGraph, [assessed("t.base", 0.1)]);
    const result = selectLesson({
      graph: prereqGraph,
      learner: view,
      now: NOW,
      mappings: [
        mapping("t.hard", { significance: 0.6 }),
        mapping("t.other", { significance: 0.55 }),
      ],
    });
    const hard = result.ranked.find((c) => c.conceptId === "t.hard")!;
    expect(hard.unmetPrerequisites.map((p) => p.id)).toEqual(["t.base"]);
    expect(hard.breakdown.penalties.map((p) => p.code)).toContain("unmet_prerequisites");
    expect(hard.breakdown.components.prerequisiteReadiness).toBeCloseTo(0.1 / 0.55, 3);
    expect(result.selected?.conceptId).toBe("t.other");
  });
});

describe("selectLesson — eligibility and honest empty states", () => {
  const graph = graphOf([concept("t.a"), concept("t.b")]);
  const learner = createLearnerView("intermediate", graph, []);

  it("excludes unknown concepts, mappings without evidence, and low relevance", () => {
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [
        mapping("t.invented"),
        mapping("t.a", { evidence: [] }),
        mapping("t.b", { relevance: 0.1 }),
      ],
    });
    expect(result.excluded).toEqual([
      { conceptId: "t.invented", reason: "unknown_concept" },
      { conceptId: "t.a", reason: "no_evidence" },
      { conceptId: "t.b", reason: "low_relevance" },
    ]);
    expect(result).toMatchObject({ selected: null, noSelectionReason: "no_eligible_mappings" });
  });

  it("keeps only the strongest mapping per concept", () => {
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [mapping("t.a", { significance: 0.2 }), mapping("t.a", { significance: 0.9 })],
    });
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]!.mapping.significance).toBe(0.9);
    expect(result.excluded).toEqual([{ conceptId: "t.a", reason: "duplicate_mapping" }]);
  });

  it("recommends nothing rather than a weak lesson when priority is below the minimum", () => {
    const strict: LearningConfig = { ...config, ranking: { ...config.ranking, minPriority: 0.99 } };
    const result = selectLesson({
      graph,
      learner,
      now: NOW,
      mappings: [mapping("t.a")],
      config: strict,
    });
    expect(result.selected).toBeNull();
    expect(result.noSelectionReason).toBe("below_minimum_priority");
    expect(result.ranked).toHaveLength(1);
  });

  it("reports no_mappings for an empty analysis", () => {
    expect(selectLesson({ graph, learner, now: NOW, mappings: [] }).noSelectionReason).toBe(
      "no_mappings",
    );
  });

  it("is deterministic, breaking ties by significance then concept ID", () => {
    const tie = [mapping("t.b"), mapping("t.a")];
    const first = selectLesson({ graph, learner, now: NOW, mappings: tie });
    const second = selectLesson({ graph, learner, now: NOW, mappings: [...tie].reverse() });
    expect(first.ranked.map((c) => c.conceptId)).toEqual(["t.a", "t.b"]);
    expect(second.ranked.map((c) => c.conceptId)).toEqual(["t.a", "t.b"]);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });
});

describe("lesson depth", () => {
  const status = (state: LearnerConceptState) => describeMastery(state, config);

  it("differs by starting level for the same mapped concept", () => {
    const { graph } = getCurriculum();
    const depths = (["novice", "intermediate", "advanced"] as const).map((level) => {
      const result = selectLesson({
        graph,
        learner: createLearnerView(level, graph, []),
        now: NOW,
        mappings: [mapping("web.retries", { suggestedDepth: "advanced" })],
      });
      return result.selected!.depth;
    });
    expect(depths).toEqual(["intro", "applied", "advanced"]);
  });

  it("reserves defense depth for demonstrated proficiency", () => {
    const highMeanThinEvidence = { ...assessed("t.a", 0.95, 1.2), sessionIds: ["s1"] };
    expect(depthFor(status(highMeanThinEvidence), "defense", config)).toBe("advanced");
    expect(depthFor(status(assessed("t.a", 0.95)), "defense", config)).toBe("defense");
  });

  it("never goes more than one step beyond what the code supports", () => {
    expect(depthFor(status(assessed("t.a", 0.95)), "intro", config)).toBe("applied");
  });
});

describe("payment-retry fixture (Milestone 1 exit criterion)", () => {
  const { graph } = getCurriculum();

  it("selects a lesson and explains why for each starting level", () => {
    for (const level of ["novice", "intermediate", "advanced"] as const) {
      const result = selectLesson({
        graph,
        learner: createLearnerView(level, graph, []),
        now: NOW,
        mappings: paymentRetryFixture.mappings,
      });
      expect(result.selected, level).not.toBeNull();
      expect(result.excluded).toEqual([]);
      expect(result.ranked).toHaveLength(paymentRetryFixture.mappings.length);
      expect(result.selected!.reasons.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("stops recommending idempotency after it has been mastered and studied", () => {
    // From an intermediate difficulty-4 prior (α=1, β=2), ten perfect engineering
    // defenses are needed to cross the 0.90 Mastered threshold; see mastery.test.ts.
    const history = Array.from({ length: 10 }, (_, i) => ({
      conceptId: "web.idempotency",
      kind: "engineering_defense" as const,
      mode: "defend" as const,
      score: 1,
      graderConfidence: 1,
      sessionId: `s${i}`,
      occurredAt: hoursAgo(10 - i),
    }));
    const state = replayEvidence(
      initialConceptState("web.idempotency", 4, "intermediate", config),
      history,
      config,
    );
    const result = selectLesson({
      graph,
      learner: createLearnerView("intermediate", graph, [state]),
      now: NOW,
      mappings: paymentRetryFixture.mappings,
      recentLessons: [{ conceptId: "web.idempotency", completedAt: hoursAgo(5) }],
    });
    expect(describeMastery(state, config).label).toBe("mastered");
    expect(result.selected?.conceptId).not.toBe("web.idempotency");
  });
});

describe("novice prerequisite penalty (curriculum review graph-01)", () => {
  const { graph, curriculum } = getCurriculum();
  const novice = createLearnerView("novice", graph, []);

  it("does not penalize prior-only novices for unmet prerequisites on most concepts", () => {
    const withPrereqs = curriculum.concepts.filter((c) => c.prerequisites.length > 0);
    const penalized = withPrereqs.filter((c) =>
      selectLesson({
        graph,
        learner: novice,
        now: NOW,
        mappings: [mapping(c.id)],
      }).ranked[0]!.breakdown.penalties.some((p) => p.code === "unmet_prerequisites"),
    );
    expect(penalized.length / withPrereqs.length).toBeLessThan(0.2);
  });

  it("ranks a central authorization gap above a weakly mapped fundamentals concept", () => {
    const result = selectLesson({
      graph,
      learner: novice,
      now: NOW,
      mappings: [
        mapping("web.authn-vs-authz", { significance: 0.9 }),
        mapping("fundamentals.values-and-types", { significance: 0.46 }),
      ],
    });
    expect(result.selected?.conceptId).toBe("web.authn-vs-authz");
  });
});
