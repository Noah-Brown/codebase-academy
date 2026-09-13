import {
  assessmentModeRank,
  type AssessmentMode,
  type ConceptDifficulty,
} from "@academy/curriculum";
import type { BetaPrior, EvidenceKind, LearningConfig, StartingLevel } from "./config";

/**
 * Current projection of a learner's knowledge of one concept. It is always
 * derivable by replaying mastery events on top of the prior.
 */
export interface LearnerConceptState {
  conceptId: string;
  priorAlpha: number;
  priorBeta: number;
  alpha: number;
  beta: number;
  /** Number of assessment items that updated this state. */
  evidenceCount: number;
  /** Sum of applied evidence weights (excludes the prior). */
  evidenceWeight: number;
  sessionIds: string[];
  /** Assessment modes where the learner scored at or above the demonstration threshold. */
  demonstratedModes: AssessmentMode[];
  highestModeDemonstrated: AssessmentMode | null;
  lastAssessedAt: Date | null;
}

export interface AssessmentEvidence {
  conceptId: string;
  kind: EvidenceKind;
  mode: AssessmentMode;
  /** 0..1 */
  score: number;
  /** 0..1 — objective items are 1. */
  graderConfidence: number;
  sessionId: string | null;
  occurredAt: Date;
}

export type MasterySkipReason = "low_grader_confidence";

export interface MasteryDelta {
  baseWeight: number;
  confidenceFactor: number;
  appliedWeight: number;
  alphaDelta: number;
  betaDelta: number;
  applied: boolean;
  skipReason: MasterySkipReason | null;
}

export function priorFor(
  level: StartingLevel,
  difficulty: ConceptDifficulty,
  config: LearningConfig,
): BetaPrior {
  return config.priors[level][difficulty];
}

export function initialConceptState(
  conceptId: string,
  difficulty: ConceptDifficulty,
  level: StartingLevel,
  config: LearningConfig,
): LearnerConceptState {
  const { alpha, beta } = priorFor(level, difficulty, config);
  return {
    conceptId,
    priorAlpha: alpha,
    priorBeta: beta,
    alpha,
    beta,
    evidenceCount: 0,
    evidenceWeight: 0,
    sessionIds: [],
    demonstratedModes: [],
    highestModeDemonstrated: null,
    lastAssessedAt: null,
  };
}

/** Posterior mean of the Beta distribution. */
export function masteryOf(state: Pick<LearnerConceptState, "alpha" | "beta">): number {
  return state.alpha / (state.alpha + state.beta);
}

function assertUnitInterval(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1 (received ${value})`);
  }
}

/** Deterministically compute how one assessed item changes the Beta parameters. */
export function computeMasteryDelta(
  evidence: Pick<AssessmentEvidence, "kind" | "score" | "graderConfidence">,
  config: LearningConfig,
): MasteryDelta {
  assertUnitInterval("score", evidence.score);
  assertUnitInterval("graderConfidence", evidence.graderConfidence);

  const baseWeight = config.evidenceWeights[evidence.kind];
  const { minConfidenceToUpdate, fullWeightConfidence } = config.grading;

  if (evidence.graderConfidence < minConfidenceToUpdate) {
    return {
      baseWeight,
      confidenceFactor: 0,
      appliedWeight: 0,
      alphaDelta: 0,
      betaDelta: 0,
      applied: false,
      skipReason: "low_grader_confidence",
    };
  }

  const confidenceFactor = Math.min(1, evidence.graderConfidence / fullWeightConfidence);
  const appliedWeight = baseWeight * confidenceFactor;
  return {
    baseWeight,
    confidenceFactor,
    appliedWeight,
    alphaDelta: appliedWeight * evidence.score,
    betaDelta: appliedWeight * (1 - evidence.score),
    applied: true,
    skipReason: null,
  };
}

/** Apply a previously computed delta. Pure: returns a new state. */
export function applyMasteryDelta(
  state: LearnerConceptState,
  evidence: AssessmentEvidence,
  delta: MasteryDelta,
  config: LearningConfig,
): LearnerConceptState {
  if (evidence.conceptId !== state.conceptId) {
    throw new Error(`Evidence for ${evidence.conceptId} applied to state for ${state.conceptId}`);
  }
  if (!delta.applied) return state;

  const sessionIds =
    evidence.sessionId && !state.sessionIds.includes(evidence.sessionId)
      ? [...state.sessionIds, evidence.sessionId]
      : state.sessionIds;

  const demonstrated = evidence.score >= config.status.demonstratedModeMinScore;
  const demonstratedModes =
    demonstrated && !state.demonstratedModes.includes(evidence.mode)
      ? [...state.demonstratedModes, evidence.mode]
      : state.demonstratedModes;
  const highestModeDemonstrated =
    demonstrated &&
    (state.highestModeDemonstrated === null ||
      assessmentModeRank(evidence.mode) > assessmentModeRank(state.highestModeDemonstrated))
      ? evidence.mode
      : state.highestModeDemonstrated;

  const lastAssessedAt =
    state.lastAssessedAt && state.lastAssessedAt > evidence.occurredAt
      ? state.lastAssessedAt
      : evidence.occurredAt;

  return {
    ...state,
    alpha: state.alpha + delta.alphaDelta,
    beta: state.beta + delta.betaDelta,
    evidenceCount: state.evidenceCount + 1,
    evidenceWeight: state.evidenceWeight + delta.appliedWeight,
    sessionIds,
    demonstratedModes,
    highestModeDemonstrated,
    lastAssessedAt,
  };
}

export function applyEvidence(
  state: LearnerConceptState,
  evidence: AssessmentEvidence,
  config: LearningConfig,
): { state: LearnerConceptState; delta: MasteryDelta } {
  const delta = computeMasteryDelta(evidence, config);
  return { state: applyMasteryDelta(state, evidence, delta, config), delta };
}

/** Rebuild a projection from its prior and an ordered evidence history. */
export function replayEvidence(
  initial: LearnerConceptState,
  history: AssessmentEvidence[],
  config: LearningConfig,
): LearnerConceptState {
  return history.reduce((state, evidence) => applyEvidence(state, evidence, config).state, initial);
}
