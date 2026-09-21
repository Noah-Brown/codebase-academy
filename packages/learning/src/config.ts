import type { ConceptDifficulty } from "@academy/curriculum";

export const STARTING_LEVELS = ["novice", "intermediate", "advanced"] as const;
export type StartingLevel = (typeof STARTING_LEVELS)[number];

export const EVIDENCE_KINDS = [
  "multiple_choice",
  "prediction",
  "trace",
  "short_explanation",
  "code_grounded_open_response",
  "design_comparison",
  "engineering_defense",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const LESSON_DEPTHS = ["intro", "applied", "advanced", "defense"] as const;
export type LessonDepth = (typeof LESSON_DEPTHS)[number];

export interface BetaPrior {
  alpha: number;
  beta: number;
}

export interface RankingWeights {
  prSignificance: number;
  masteryGap: number;
  prerequisiteReadiness: number;
  novelty: number;
  operationalImportance: number;
}

/**
 * Every tunable number in the learner model and ranker. Values here are product
 * parameters, not invariants — tests assert behavior relative to the config.
 */
export interface LearningConfig {
  /** Pseudo-counts by starting level and concept difficulty. Priors are never evidence. */
  priors: Record<StartingLevel, Record<ConceptDifficulty, BetaPrior>>;
  evidenceWeights: Record<EvidenceKind, number>;
  grading: {
    /** Below this grader confidence, feedback is shown but mastery is not updated. */
    minConfidenceToUpdate: number;
    /** At or above this confidence, full evidence weight applies; below it weight scales down. */
    fullWeightConfidence: number;
    /** Credit an open-response rubric criterion earns for each grader result (D25). */
    criterionCredit: Record<"yes" | "partial" | "no", number>;
    /** Confidence multiplier per yes/partial criterion whose quoted evidence is not in the answer. */
    unverifiedEvidenceConfidenceFactor: number;
  };
  status: {
    /** Accumulated evidence weight below which a concept is labeled New regardless of mean. */
    newBelowEvidenceWeight: number;
    learningBelow: number;
    developingBelow: number;
    masteredAtOrAbove: number;
    proficientMinEvidenceWeight: number;
    masteredMinEvidenceWeight: number;
    /** Mastered also needs evidence from more than one session OR more than one assessment mode. */
    masteredMinDistinctSessions: number;
    masteredMinDistinctModes: number;
    /** Score at which an assessment mode counts as demonstrated. */
    demonstratedModeMinScore: number;
  };
  depth: {
    /** Mastery mean thresholds for choosing lesson depth. */
    introBelow: number;
    appliedBelow: number;
    advancedBelow: number;
  };
  ranking: {
    weights: RankingWeights;
    /** Prerequisite mastery at which it counts as fully ready (readiness = mastery / this, capped at 1). */
    prerequisiteReadyMastery: number;
    /**
     * Prerequisites below this mastery are reported as unmet and trigger a penalty.
     * Must stay below every starting-level prior for difficulty 1–2, or prior-only
     * learners are penalized on nearly every concept (curriculum review graph-01).
     */
    unmetPrerequisiteMastery: number;
    penalties: {
      recentLesson: number;
      /** Scaled by the fraction of direct prerequisites that are unmet. */
      unmetPrerequisites: number;
      weakEvidence: number;
    };
    recentLessonWindowHours: number;
    weakEvidenceRelevance: number;
    /** Mappings below this relevance are excluded entirely. */
    minRelevance: number;
    /** If the best candidate scores below this, recommend nothing rather than a generic lesson. */
    minPriority: number;
  };
}

export const defaultLearningConfig: LearningConfig = {
  priors: {
    novice: {
      1: { alpha: 1, beta: 2 },
      2: { alpha: 1, beta: 2.5 },
      3: { alpha: 1, beta: 3 },
      4: { alpha: 1, beta: 3.5 },
      5: { alpha: 1, beta: 4 },
    },
    intermediate: {
      1: { alpha: 2, beta: 1.5 },
      2: { alpha: 2, beta: 2 },
      3: { alpha: 1.5, beta: 2 },
      4: { alpha: 1, beta: 2 },
      5: { alpha: 1, beta: 2.5 },
    },
    advanced: {
      1: { alpha: 3, beta: 1.5 },
      2: { alpha: 3, beta: 2 },
      3: { alpha: 2.5, beta: 2 },
      4: { alpha: 2, beta: 2 },
      5: { alpha: 1.5, beta: 2 },
    },
  },
  evidenceWeights: {
    multiple_choice: 0.5,
    prediction: 0.8,
    trace: 0.8,
    short_explanation: 1.0,
    code_grounded_open_response: 1.3,
    design_comparison: 1.5,
    engineering_defense: 2.0,
  },
  grading: {
    minConfidenceToUpdate: 0.4,
    fullWeightConfidence: 0.7,
    criterionCredit: { yes: 1, partial: 0.5, no: 0 },
    unverifiedEvidenceConfidenceFactor: 0.5,
  },
  status: {
    newBelowEvidenceWeight: 1.0,
    learningBelow: 0.55,
    developingBelow: 0.75,
    masteredAtOrAbove: 0.9,
    proficientMinEvidenceWeight: 2.0,
    masteredMinEvidenceWeight: 4.0,
    masteredMinDistinctSessions: 2,
    masteredMinDistinctModes: 2,
    demonstratedModeMinScore: 0.7,
  },
  depth: {
    introBelow: 0.4,
    appliedBelow: 0.55,
    advancedBelow: 0.85,
  },
  ranking: {
    weights: {
      prSignificance: 0.35,
      masteryGap: 0.25,
      prerequisiteReadiness: 0.2,
      novelty: 0.1,
      operationalImportance: 0.1,
    },
    prerequisiteReadyMastery: 0.55,
    unmetPrerequisiteMastery: 0.25,
    penalties: {
      recentLesson: 0.3,
      unmetPrerequisites: 0.15,
      weakEvidence: 0.15,
    },
    recentLessonWindowHours: 72,
    weakEvidenceRelevance: 0.5,
    minRelevance: 0.3,
    minPriority: 0.2,
  },
};
