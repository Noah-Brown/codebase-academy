import { getCurriculum } from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import { STARTING_LEVELS, defaultLearningConfig as config, type LearningConfig } from "./config";
import {
  applyEvidence,
  computeMasteryDelta,
  initialConceptState,
  masteryOf,
  replayEvidence,
  type AssessmentEvidence,
  type LearnerConceptState,
} from "./mastery";
import { describeMastery } from "./status";

const T0 = new Date("2026-09-01T12:00:00Z");

function evidence(overrides: Partial<AssessmentEvidence> = {}): AssessmentEvidence {
  return {
    conceptId: "web.idempotency",
    kind: "short_explanation",
    mode: "explain",
    score: 1,
    graderConfidence: 1,
    sessionId: "s1",
    occurredAt: T0,
    ...overrides,
  };
}

const fresh = (): LearnerConceptState =>
  initialConceptState("web.idempotency", 4, "intermediate", config);

describe("Beta mastery update", () => {
  it("adds weight × score to alpha and weight × (1 − score) to beta", () => {
    const start = fresh();
    const { state, delta } = applyEvidence(
      start,
      evidence({ kind: "code_grounded_open_response", score: 0.75 }),
      config,
    );
    expect(delta.appliedWeight).toBeCloseTo(1.3);
    expect(state.alpha).toBeCloseTo(start.alpha + 1.3 * 0.75);
    expect(state.beta).toBeCloseTo(start.beta + 1.3 * 0.25);
    expect(masteryOf(state)).toBeCloseTo(state.alpha / (state.alpha + state.beta));
    expect(state.evidenceCount).toBe(1);
    expect(state.evidenceWeight).toBeCloseTo(1.3);
  });

  it("uses the configured weight for each evidence kind", () => {
    const expected: Record<string, number> = {
      multiple_choice: 0.5,
      prediction: 0.8,
      trace: 0.8,
      short_explanation: 1.0,
      code_grounded_open_response: 1.3,
      design_comparison: 1.5,
      engineering_defense: 2.0,
    };
    for (const [kind, weight] of Object.entries(expected)) {
      const delta = computeMasteryDelta(
        { kind: kind as never, score: 1, graderConfidence: 1 },
        config,
      );
      expect(delta.appliedWeight, kind).toBe(weight);
    }
  });

  it("moves mastery up on correct answers and down on incorrect ones", () => {
    const start = fresh();
    expect(masteryOf(applyEvidence(start, evidence({ score: 1 }), config).state)).toBeGreaterThan(
      masteryOf(start),
    );
    expect(masteryOf(applyEvidence(start, evidence({ score: 0 }), config).state)).toBeLessThan(
      masteryOf(start),
    );
  });

  it("rejects scores and confidences outside 0..1", () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyEvidence(fresh(), evidence({ score: bad }), config)).toThrow(RangeError);
      expect(() => applyEvidence(fresh(), evidence({ graderConfidence: bad }), config)).toThrow(
        RangeError,
      );
    }
  });

  it("refuses to apply evidence to a different concept's state", () => {
    expect(() => applyEvidence(fresh(), evidence({ conceptId: "db.indexes" }), config)).toThrow();
  });
});

describe("grader confidence", () => {
  it("does not update mastery when confidence is below the threshold", () => {
    const start = fresh();
    const { state, delta } = applyEvidence(start, evidence({ graderConfidence: 0.2 }), config);
    expect(delta).toMatchObject({
      applied: false,
      skipReason: "low_grader_confidence",
      appliedWeight: 0,
    });
    expect(state).toEqual(start);
  });

  it("scales evidence weight between the minimum and full-weight thresholds", () => {
    const delta = computeMasteryDelta(
      { kind: "short_explanation", score: 1, graderConfidence: 0.35 * 2 * 0.5 + 0.2 },
      config,
    );
    expect(delta.applied).toBe(true);
    expect(delta.appliedWeight).toBeCloseTo(0.55 / 0.7);
  });

  it("applies full weight at or above the full-weight threshold", () => {
    expect(
      computeMasteryDelta({ kind: "short_explanation", score: 1, graderConfidence: 0.7 }, config)
        .appliedWeight,
    ).toBe(1);
  });
});

describe("projection bookkeeping", () => {
  it("tracks distinct sessions, demonstrated modes, and the highest mode demonstrated", () => {
    const history = [
      evidence({ kind: "multiple_choice", mode: "recognize", sessionId: "s1", score: 1 }),
      evidence({ kind: "engineering_defense", mode: "defend", sessionId: "s1", score: 0.4 }),
      evidence({ kind: "design_comparison", mode: "compare", sessionId: "s2", score: 0.8 }),
      evidence({ kind: "prediction", mode: "predict", sessionId: "s2", score: 0.9 }),
    ];
    const state = replayEvidence(fresh(), history, config);
    expect(state.sessionIds).toEqual(["s1", "s2"]);
    expect(state.demonstratedModes).toEqual(["recognize", "compare", "predict"]);
    expect(state.highestModeDemonstrated).toBe("compare");
  });

  it("keeps the latest assessment time even when evidence arrives out of order", () => {
    const later = new Date(T0.getTime() + 60_000);
    const state = replayEvidence(
      fresh(),
      [evidence({ occurredAt: later }), evidence({ occurredAt: T0 })],
      config,
    );
    expect(state.lastAssessedAt).toEqual(later);
  });

  it("replay equals sequential application and is deterministic", () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      evidence({
        score: (i % 5) / 4,
        graderConfidence: 0.3 + (i % 8) / 10,
        sessionId: `s${i % 3}`,
      }),
    );
    let sequential = fresh();
    for (const item of history) sequential = applyEvidence(sequential, item, config).state;
    expect(replayEvidence(fresh(), history, config)).toEqual(sequential);
    expect(replayEvidence(fresh(), history, config)).toEqual(
      replayEvidence(fresh(), history, config),
    );
  });
});

describe("starting-level priors", () => {
  const { curriculum } = getCurriculum();

  it("never label any concept as anything but New before evidence, at any level", () => {
    for (const level of STARTING_LEVELS) {
      for (const concept of curriculum.concepts) {
        const status = describeMastery(
          initialConceptState(concept.id, concept.difficulty, level, config),
          config,
        );
        expect(status.label).toBe("new");
        expect(status.evidenceStrength).toBe("none");
        expect(status.mastery).toBeLessThan(config.status.masteredAtOrAbove);
      }
    }
  });

  it("orders prior mastery novice < intermediate < advanced for every difficulty", () => {
    for (const difficulty of [1, 2, 3, 4, 5] as const) {
      const [novice, intermediate, advanced] = STARTING_LEVELS.map((level) =>
        masteryOf(initialConceptState("x.y", difficulty, level, config)),
      );
      expect(novice).toBeLessThan(intermediate!);
      expect(intermediate).toBeLessThan(advanced!);
    }
  });
});

describe("mastery status labels", () => {
  const withState = (overrides: Partial<LearnerConceptState>): LearnerConceptState => ({
    ...fresh(),
    ...overrides,
  });

  it("maps mean thresholds to labels once evidence is sufficient", () => {
    const strong = {
      evidenceWeight: 10,
      sessionIds: ["a", "b"],
      demonstratedModes: ["explain" as const],
    };
    const label = (alpha: number, beta: number) =>
      describeMastery(withState({ alpha, beta, ...strong }), config).label;
    expect(label(5, 5)).toBe("learning"); // 0.50
    expect(label(55, 45)).toBe("developing"); // 0.55
    expect(label(74, 26)).toBe("developing"); // 0.74
    expect(label(75, 25)).toBe("proficient"); // 0.75
    expect(label(89, 11)).toBe("proficient"); // 0.89
    expect(label(90, 10)).toBe("mastered"); // 0.90
  });

  it("reports insufficient evidence instead of Mastered when the mean is high but evidence is thin", () => {
    const status = describeMastery(
      withState({ alpha: 19, beta: 1, evidenceWeight: 1.5, evidenceCount: 2, sessionIds: ["s1"] }),
      config,
    );
    expect(status.estimateLabel).toBe("mastered");
    expect(status.label).toBe("developing");
    expect(status.insufficientEvidence).toBe(true);
    expect(status.evidenceStrength).toBe("limited");
  });

  it("requires breadth across sessions or modes for Mastered", () => {
    const base = { alpha: 19, beta: 1, evidenceWeight: 6 };
    const oneSessionOneMode = describeMastery(
      withState({ ...base, sessionIds: ["s1"], demonstratedModes: ["explain"] }),
      config,
    );
    expect(oneSessionOneMode.label).toBe("proficient");
    expect(oneSessionOneMode.insufficientEvidence).toBe(true);

    expect(
      describeMastery(
        withState({ ...base, sessionIds: ["s1", "s2"], demonstratedModes: ["explain"] }),
        config,
      ).label,
    ).toBe("mastered");
    expect(
      describeMastery(
        withState({ ...base, sessionIds: ["s1"], demonstratedModes: ["explain", "defend"] }),
        config,
      ).label,
    ).toBe("mastered");
  });

  it("honors configured thresholds", () => {
    const strict: LearningConfig = {
      ...config,
      status: { ...config.status, masteredAtOrAbove: 0.99 },
    };
    const state = withState({ alpha: 95, beta: 5, evidenceWeight: 10, sessionIds: ["a", "b"] });
    expect(describeMastery(state, config).label).toBe("mastered");
    expect(describeMastery(state, strict).label).toBe("proficient");
  });

  it("documents calibration: Mastered demands sustained evidence under the default priors", () => {
    // Tuning reference, not a hard requirement. With β=2 and a 0.90 threshold,
    // α must reach 18, so from α=1 it takes nine perfect engineering defenses (weight 2).
    const perfectDefenses = (n: number) =>
      replayEvidence(
        fresh(),
        Array.from({ length: n }, (_, i) =>
          evidence({ kind: "engineering_defense", mode: "defend", sessionId: `s${i}` }),
        ),
        config,
      );
    expect(describeMastery(perfectDefenses(6), config).label).toBe("proficient");
    expect(describeMastery(perfectDefenses(8), config).label).toBe("proficient");
    expect(describeMastery(perfectDefenses(9), config).label).toBe("mastered");
  });

  it("a realistic first lesson leaves New and shows the change", () => {
    let state = initialConceptState("web.retries", 3, "intermediate", config);
    state = applyEvidence(
      state,
      evidence({ conceptId: "web.retries", kind: "multiple_choice", mode: "recognize" }),
      config,
    ).state;
    state = applyEvidence(
      state,
      evidence({
        conceptId: "web.retries",
        kind: "code_grounded_open_response",
        score: 0.8,
        graderConfidence: 0.9,
      }),
      config,
    ).state;
    const status = describeMastery(state, config);
    expect(status.label).not.toBe("new");
    expect(status.evidenceCount).toBe(2);
    expect(status.evidenceWeight).toBeCloseTo(1.8);
  });
});
