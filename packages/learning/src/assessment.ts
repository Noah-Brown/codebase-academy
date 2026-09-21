import type { AssessmentMode } from "@academy/curriculum";
import { defaultLearningConfig, type EvidenceKind, type LearningConfig } from "./config";

/** Modes answered by picking a choice; graded deterministically. */
export const OBJECTIVE_MODES = [
  "recognize",
  "predict",
  "trace",
] as const satisfies readonly AssessmentMode[];
/** Modes answered in the learner's own words; graded against a rubric. */
export const OPEN_RESPONSE_MODES = [
  "explain",
  "compare",
  "design",
  "defend",
] as const satisfies readonly AssessmentMode[];
export type ObjectiveMode = (typeof OBJECTIVE_MODES)[number];
export type OpenResponseMode = (typeof OPEN_RESPONSE_MODES)[number];

export const CRITERION_RESULTS = ["yes", "partial", "no"] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

export type AssessedStep =
  | { type: "multiple_choice"; mode: ObjectiveMode }
  | { type: "open_response"; mode: OpenResponseMode; codeGrounded: boolean };

/** The evidence kind, and so the weight, that an assessed lesson step contributes (brief §11). */
export function evidenceKindFor(step: AssessedStep): EvidenceKind {
  if (step.type === "multiple_choice") {
    if (step.mode === "recognize") return "multiple_choice";
    return step.mode === "predict" ? "prediction" : "trace";
  }
  switch (step.mode) {
    case "explain":
      return step.codeGrounded ? "code_grounded_open_response" : "short_explanation";
    case "compare":
    case "design":
      return "design_comparison";
    case "defend":
      return "engineering_defense";
  }
}

/**
 * An open response's score from its rubric results: the weighted share of credit, where each result
 * earns the configured credit (yes 1, partial 0.5, no 0 by default). Deterministic, so a stored
 * grading result always reproduces its score.
 */
export function scoreFromCriteria(
  results: ReadonlyArray<{ weight: number; met: CriterionResult }>,
  config: LearningConfig = defaultLearningConfig,
): number {
  const total = results.reduce((sum, result) => sum + result.weight, 0);
  if (!(total > 0) || results.some((result) => !(result.weight >= 0))) {
    throw new Error("Rubric weights must be non-negative and sum to a positive number");
  }
  const earned = results.reduce(
    (sum, result) => sum + result.weight * config.grading.criterionCredit[result.met],
    0,
  );
  return Math.round((earned / total) * 10_000) / 10_000;
}

/**
 * Grader confidence after quote verification: each yes/partial criterion whose quoted evidence is not
 * in the learner's answer multiplies confidence by the configured factor.
 */
export function verifiedGraderConfidence(
  reportedConfidence: number,
  unverifiedCriteria: number,
  config: LearningConfig = defaultLearningConfig,
): number {
  const clamped = Math.min(1, Math.max(0, reportedConfidence));
  const factor = config.grading.unverifiedEvidenceConfidenceFactor ** unverifiedCriteria;
  return Math.round(clamped * factor * 10_000) / 10_000;
}
