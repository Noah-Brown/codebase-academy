import { describe, expect, it } from "vitest";
import { evidenceKindFor, scoreFromCriteria, verifiedGraderConfidence } from "./assessment";
import { defaultLearningConfig } from "./config";

describe("evidenceKindFor", () => {
  it("maps objective modes to the brief's evidence kinds", () => {
    expect(evidenceKindFor({ type: "multiple_choice", mode: "recognize" })).toBe("multiple_choice");
    expect(evidenceKindFor({ type: "multiple_choice", mode: "predict" })).toBe("prediction");
    expect(evidenceKindFor({ type: "multiple_choice", mode: "trace" })).toBe("trace");
  });

  it("weights open responses by how much they demand", () => {
    const open = (mode: "explain" | "compare" | "design" | "defend", codeGrounded = false) =>
      evidenceKindFor({ type: "open_response", mode, codeGrounded });
    expect(open("explain")).toBe("short_explanation");
    expect(open("explain", true)).toBe("code_grounded_open_response");
    expect(open("compare")).toBe("design_comparison");
    expect(open("design")).toBe("design_comparison");
    expect(open("defend", true)).toBe("engineering_defense");

    const weights = defaultLearningConfig.evidenceWeights;
    expect(weights[open("defend")]).toBeGreaterThan(weights[open("explain", true)]);
    expect(weights[open("explain", true)]).toBeGreaterThan(weights[open("explain")]);
  });
});

describe("scoreFromCriteria", () => {
  it("is the weighted share of credit", () => {
    expect(
      scoreFromCriteria([
        { weight: 0.5, met: "yes" },
        { weight: 0.3, met: "partial" },
        { weight: 0.2, met: "no" },
      ]),
    ).toBe(0.65);
    expect(
      scoreFromCriteria([
        { weight: 2, met: "yes" },
        { weight: 2, met: "yes" },
      ]),
    ).toBe(1);
    expect(scoreFromCriteria([{ weight: 1, met: "no" }])).toBe(0);
  });

  it("uses the configured credit", () => {
    const config = {
      ...defaultLearningConfig,
      grading: {
        ...defaultLearningConfig.grading,
        criterionCredit: { yes: 1, partial: 0.25, no: 0 },
      },
    };
    expect(scoreFromCriteria([{ weight: 1, met: "partial" }], config)).toBe(0.25);
  });

  it("rejects rubrics without positive total weight", () => {
    expect(() => scoreFromCriteria([])).toThrow();
    expect(() => scoreFromCriteria([{ weight: 0, met: "yes" }])).toThrow();
    expect(() =>
      scoreFromCriteria([
        { weight: -1, met: "yes" },
        { weight: 2, met: "no" },
      ]),
    ).toThrow();
  });
});

describe("verifiedGraderConfidence", () => {
  it("keeps confidence when every quote was found", () => {
    expect(verifiedGraderConfidence(0.8, 0)).toBe(0.8);
  });

  it("halves confidence for each unverified quote and clamps to 0..1", () => {
    expect(verifiedGraderConfidence(0.8, 1)).toBe(0.4);
    expect(verifiedGraderConfidence(0.8, 2)).toBe(0.2);
    expect(verifiedGraderConfidence(1.4, 0)).toBe(1);
    expect(verifiedGraderConfidence(-0.2, 0)).toBe(0);
  });
});
