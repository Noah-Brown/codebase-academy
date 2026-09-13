import type { CurriculumConcept, CurriculumGraph } from "@academy/curriculum";
import {
  LESSON_DEPTHS,
  defaultLearningConfig,
  type LearningConfig,
  type LessonDepth,
  type RankingWeights,
  type StartingLevel,
} from "./config";
import { initialConceptState, masteryOf, type LearnerConceptState } from "./mastery";
import { MASTERY_LABEL_TEXT, describeMastery, type MasteryStatus } from "./status";

/** Output of the concept mapper, validated upstream against the curriculum and the PR. */
export interface MappedConcept {
  conceptId: string;
  /** 0..1 — how clearly the code exhibits the concept. */
  relevance: number;
  /** 0..1 — importance of the concept to understanding this PR. */
  significance: number;
  evidence: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    excerpt: string;
    rationale: string;
  }>;
  suggestedDepth: LessonDepth;
}

export interface RecentLesson {
  conceptId: string;
  completedAt: Date;
}

export interface LearnerView {
  level: StartingLevel;
  stateFor(conceptId: string): LearnerConceptState;
}

/** A learner's states, falling back to starting-level priors for concepts never assessed. */
export function createLearnerView(
  level: StartingLevel,
  graph: CurriculumGraph,
  states: Iterable<LearnerConceptState>,
  config: LearningConfig = defaultLearningConfig,
): LearnerView {
  const byId = new Map([...states].map((state) => [state.conceptId, state]));
  return {
    level,
    stateFor(conceptId) {
      return (
        byId.get(conceptId) ??
        initialConceptState(conceptId, graph.require(conceptId).difficulty, level, config)
      );
    },
  };
}

export type PenaltyCode = "recent_lesson" | "unmet_prerequisites" | "weak_evidence";

export interface ScoreBreakdown {
  /** Raw 0..1 components. */
  components: RankingWeights;
  /** Components multiplied by their weights. */
  weighted: RankingWeights;
  basePriority: number;
  penalties: Array<{ code: PenaltyCode; amount: number }>;
  priority: number;
}

export interface RankedCandidate {
  conceptId: string;
  concept: CurriculumConcept;
  mapping: MappedConcept;
  status: MasteryStatus;
  depth: LessonDepth;
  unmetPrerequisites: CurriculumConcept[];
  breakdown: ScoreBreakdown;
  /** Human-readable, deterministic explanation of the ranking. */
  reasons: string[];
}

export type ExclusionReason =
  "unknown_concept" | "low_relevance" | "no_evidence" | "duplicate_mapping";

export interface SelectionResult {
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  excluded: Array<{ conceptId: string; reason: ExclusionReason }>;
  noSelectionReason: "no_mappings" | "no_eligible_mappings" | "below_minimum_priority" | null;
}

export interface SelectionInput {
  mappings: MappedConcept[];
  graph: CurriculumGraph;
  learner: LearnerView;
  recentLessons?: RecentLesson[];
  now: Date;
  config?: LearningConfig;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function depthFor(
  status: MasteryStatus,
  suggestedDepth: LessonDepth,
  config: LearningConfig,
): LessonDepth {
  const { introBelow, appliedBelow, advancedBelow } = config.depth;
  const byMastery: LessonDepth =
    status.mastery < introBelow
      ? "intro"
      : status.mastery < appliedBelow
        ? "applied"
        : status.mastery < advancedBelow
          ? "advanced"
          : "defense";

  // Defense requires demonstrated proficiency, and lessons never go more than one
  // step deeper than the code itself supports.
  const evidenceCap: LessonDepth =
    status.label === "proficient" || status.label === "mastered" ? "defense" : "advanced";
  const codeCap = LESSON_DEPTHS[Math.min(LESSON_DEPTHS.indexOf(suggestedDepth) + 1, 3)]!;

  const index = Math.min(
    LESSON_DEPTHS.indexOf(byMastery),
    LESSON_DEPTHS.indexOf(evidenceCap),
    LESSON_DEPTHS.indexOf(codeCap),
  );
  return LESSON_DEPTHS[index]!;
}

/**
 * Rank mapped concepts for one learner and pick at most one lesson.
 * Deterministic: identical input always yields identical output and ordering.
 */
export function selectLesson(input: SelectionInput): SelectionResult {
  const config = input.config ?? defaultLearningConfig;
  const { graph } = input;
  const ranking = config.ranking;
  const excluded: SelectionResult["excluded"] = [];

  if (input.mappings.length === 0) {
    return { selected: null, ranked: [], excluded, noSelectionReason: "no_mappings" };
  }

  // Keep the strongest mapping per concept.
  const strength = (m: MappedConcept) => m.relevance * m.significance;
  const bestByConcept = new Map<string, MappedConcept>();
  for (const mapping of input.mappings) {
    if (!graph.has(mapping.conceptId)) {
      excluded.push({ conceptId: mapping.conceptId, reason: "unknown_concept" });
      continue;
    }
    if (mapping.evidence.length === 0) {
      excluded.push({ conceptId: mapping.conceptId, reason: "no_evidence" });
      continue;
    }
    if (mapping.relevance < ranking.minRelevance) {
      excluded.push({ conceptId: mapping.conceptId, reason: "low_relevance" });
      continue;
    }
    const existing = bestByConcept.get(mapping.conceptId);
    if (existing) {
      excluded.push({ conceptId: mapping.conceptId, reason: "duplicate_mapping" });
      if (strength(mapping) <= strength(existing)) continue;
    }
    bestByConcept.set(mapping.conceptId, mapping);
  }

  const ranked = [...bestByConcept.values()].map((mapping) =>
    scoreCandidate(mapping, input, config),
  );
  ranked.sort(
    (a, b) =>
      b.breakdown.priority - a.breakdown.priority ||
      b.mapping.significance - a.mapping.significance ||
      a.conceptId.localeCompare(b.conceptId),
  );

  if (ranked.length === 0) {
    return { selected: null, ranked, excluded, noSelectionReason: "no_eligible_mappings" };
  }
  const top = ranked[0]!;
  if (top.breakdown.priority < ranking.minPriority) {
    return { selected: null, ranked, excluded, noSelectionReason: "below_minimum_priority" };
  }
  return { selected: top, ranked, excluded, noSelectionReason: null };
}

function scoreCandidate(
  mapping: MappedConcept,
  input: SelectionInput,
  config: LearningConfig,
): RankedCandidate {
  const { graph, learner, now } = input;
  const ranking = config.ranking;
  const concept = graph.require(mapping.conceptId);
  const state = learner.stateFor(concept.id);
  const status = describeMastery(state, config);

  const prerequisites = graph.directPrerequisites(concept.id);
  const prerequisiteMastery = prerequisites.map((p) => ({
    concept: p,
    mastery: masteryOf(learner.stateFor(p.id)),
  }));
  const prerequisiteReadiness =
    prerequisites.length === 0
      ? 1
      : prerequisiteMastery.reduce(
          (sum, p) => sum + Math.min(1, p.mastery / ranking.prerequisiteReadyMastery),
          0,
        ) / prerequisites.length;
  const unmetPrerequisites = prerequisiteMastery
    .filter((p) => p.mastery < ranking.unmetPrerequisiteMastery)
    .map((p) => p.concept);

  const components: RankingWeights = {
    prSignificance: clamp01(mapping.significance),
    masteryGap: 1 - status.mastery,
    prerequisiteReadiness,
    novelty: 1 / (1 + state.evidenceCount),
    operationalImportance: concept.operationalImportance,
  };
  const weighted = Object.fromEntries(
    Object.entries(components).map(([key, value]) => [
      key,
      round(value * ranking.weights[key as keyof RankingWeights]),
    ]),
  ) as unknown as RankingWeights;
  const basePriority = round(Object.values(weighted).reduce((sum, value) => sum + value, 0));

  const penalties: ScoreBreakdown["penalties"] = [];
  const windowMs = ranking.recentLessonWindowHours * 3_600_000;
  const studiedRecently = (input.recentLessons ?? []).some(
    (lesson) =>
      lesson.conceptId === concept.id &&
      now.getTime() - lesson.completedAt.getTime() >= 0 &&
      now.getTime() - lesson.completedAt.getTime() < windowMs,
  );
  if (studiedRecently) {
    penalties.push({ code: "recent_lesson", amount: ranking.penalties.recentLesson });
  }
  if (unmetPrerequisites.length > 0) {
    penalties.push({
      code: "unmet_prerequisites",
      amount: round(
        ranking.penalties.unmetPrerequisites * (unmetPrerequisites.length / prerequisites.length),
      ),
    });
  }
  if (mapping.relevance < ranking.weakEvidenceRelevance) {
    penalties.push({ code: "weak_evidence", amount: ranking.penalties.weakEvidence });
  }

  const priority = round(basePriority - penalties.reduce((sum, p) => sum + p.amount, 0));
  const breakdown: ScoreBreakdown = { components, weighted, basePriority, penalties, priority };
  const depth = depthFor(status, mapping.suggestedDepth, config);

  return {
    conceptId: concept.id,
    concept,
    mapping,
    status,
    depth,
    unmetPrerequisites,
    breakdown,
    reasons: explainCandidate(
      { concept, mapping, status, depth, unmetPrerequisites, breakdown },
      prerequisites.length,
    ),
  };
}

const DEPTH_TEXT: Record<LessonDepth, string> = {
  intro: "an introductory",
  applied: "an applied",
  advanced: "an advanced",
  defense: "an engineering-defense",
};

function explainCandidate(
  candidate: Omit<RankedCandidate, "conceptId" | "reasons">,
  prerequisiteCount: number,
): string[] {
  const { concept, mapping, status, depth, unmetPrerequisites, breakdown } = candidate;
  const reasons: string[] = [];

  if (mapping.significance >= 0.7) {
    reasons.push(`${concept.title} is central to understanding this change.`);
  } else if (mapping.significance >= 0.4) {
    reasons.push(`${concept.title} plays a meaningful role in this change.`);
  } else {
    reasons.push(`${concept.title} appears in a supporting role in this change.`);
  }

  if (status.label === "new") {
    reasons.push(`You haven't been assessed on ${concept.title} yet.`);
  } else if (status.insufficientEvidence) {
    reasons.push(
      `Your answers so far look ${MASTERY_LABEL_TEXT[status.estimateLabel]}, but there isn't enough evidence to confirm it.`,
    );
  } else if (status.label === "learning" || status.label === "developing") {
    reasons.push(
      `Your current level here is ${MASTERY_LABEL_TEXT[status.label]}, so there is room to grow.`,
    );
  } else {
    reasons.push(
      `You've shown ${MASTERY_LABEL_TEXT[status.label]} understanding; this goes deeper.`,
    );
  }

  if (unmetPrerequisites.length > 0) {
    reasons.push(
      `It builds on ${unmetPrerequisites.map((p) => p.title).join(", ")}, which you may want to cover first.`,
    );
  } else if (prerequisiteCount > 0) {
    reasons.push("Its prerequisites look ready.");
  }

  if (concept.operationalImportance >= 0.8) {
    reasons.push(
      "Misunderstanding it commonly leads to security, data-integrity, or availability problems.",
    );
  }

  for (const penalty of breakdown.penalties) {
    if (penalty.code === "recent_lesson")
      reasons.push("You studied this recently, so it ranks lower today.");
    if (penalty.code === "weak_evidence")
      reasons.push("The code evidence for it in this PR is relatively weak.");
  }

  reasons.push(`Pitched as ${DEPTH_TEXT[depth]} lesson for your current level.`);
  return reasons;
}
