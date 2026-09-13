import type { LearningConfig } from "./config";
import { masteryOf, type LearnerConceptState } from "./mastery";

export const MASTERY_LABELS = ["new", "learning", "developing", "proficient", "mastered"] as const;
export type MasteryLabel = (typeof MASTERY_LABELS)[number];

export const MASTERY_LABEL_TEXT: Record<MasteryLabel, string> = {
  new: "New",
  learning: "Learning",
  developing: "Developing",
  proficient: "Proficient",
  mastered: "Mastered",
};

export type EvidenceStrength = "none" | "limited" | "moderate" | "strong";

export interface MasteryStatus {
  label: MasteryLabel;
  /** Posterior mean, 0..1. Show coarsely; never as false precision. */
  mastery: number;
  /** Label the mean alone would earn, before evidence requirements are applied. */
  estimateLabel: Exclude<MasteryLabel, "new">;
  /** True when the evidence is too thin to support the label the mean alone suggests. */
  insufficientEvidence: boolean;
  evidenceStrength: EvidenceStrength;
  evidenceCount: number;
  evidenceWeight: number;
}

/**
 * Map a projection to a UI label. The mastery estimate and the strength of the
 * evidence behind it are reported separately, so a high mean with little
 * evidence reads as "insufficient evidence" rather than "Mastered".
 */
export function describeMastery(state: LearnerConceptState, config: LearningConfig): MasteryStatus {
  const s = config.status;
  const mastery = masteryOf(state);

  const estimateLabel: MasteryStatus["estimateLabel"] =
    mastery < s.learningBelow
      ? "learning"
      : mastery < s.developingBelow
        ? "developing"
        : mastery < s.masteredAtOrAbove
          ? "proficient"
          : "mastered";

  let label: MasteryLabel = estimateLabel;
  if (state.evidenceWeight < s.newBelowEvidenceWeight) {
    label = "new";
  } else {
    if (label === "mastered") {
      const breadth =
        state.sessionIds.length >= s.masteredMinDistinctSessions ||
        state.demonstratedModes.length >= s.masteredMinDistinctModes;
      if (state.evidenceWeight < s.masteredMinEvidenceWeight || !breadth) label = "proficient";
    }
    if (label === "proficient" && state.evidenceWeight < s.proficientMinEvidenceWeight) {
      label = "developing";
    }
  }

  const evidenceStrength: EvidenceStrength =
    state.evidenceWeight === 0
      ? "none"
      : state.evidenceWeight < s.proficientMinEvidenceWeight
        ? "limited"
        : state.evidenceWeight < s.masteredMinEvidenceWeight
          ? "moderate"
          : "strong";

  return {
    label,
    mastery,
    estimateLabel,
    insufficientEvidence: label !== estimateLabel,
    evidenceStrength,
    evidenceCount: state.evidenceCount,
    evidenceWeight: state.evidenceWeight,
  };
}
