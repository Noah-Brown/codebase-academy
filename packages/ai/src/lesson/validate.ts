import type { CurriculumConcept, CurriculumGraph } from "@academy/curriculum";
import {
  OBJECTIVE_MODES,
  OPEN_RESPONSE_MODES,
  scoreFromCriteria,
  verifiedGraderConfidence,
  type CriterionResult,
  type LearningConfig,
  type LessonDepth,
} from "@academy/learning";
import {
  defaultGraderConfig,
  defaultLessonGeneratorConfig,
  type GraderConfig,
  type LessonGeneratorConfig,
} from "./config";
import type { LessonContent, LessonEvidence, LessonStep, OpenResponseStep } from "./content";
import type { GraderOutput, LessonOutput } from "./schema";

/** A generated lesson or grade that cannot be used. `issues` are codes, never content. */
export class OutputValidationError extends Error {
  constructor(
    readonly issues: string[],
    /** Counts behind the issues (steps, assessments, ...), for diagnostics. Never content. */
    readonly stats: Record<string, number> = {},
  ) {
    super(`invalid model output: ${issues.join(", ")}`);
    this.name = "OutputValidationError";
  }
}

const DEPTH_ORDER: LessonDepth[] = ["intro", "applied", "advanced", "defense"];

/** Assessment modes a lesson at this depth may use, before intersecting with the concept's modes. */
export function modesForDepth(depth: LessonDepth): string[] {
  const rank = DEPTH_ORDER.indexOf(depth);
  return [
    ...OBJECTIVE_MODES,
    "explain",
    ...(rank >= 2 ? ["compare", "design"] : []),
    ...(rank >= 3 ? ["defend"] : []),
  ];
}

/** Modes this lesson may assess: the concept's canonical modes that suit the depth. */
export function allowedModes(concept: CurriculumConcept, depth: LessonDepth): string[] {
  const forDepth = modesForDepth(depth);
  return concept.assessmentModes.filter((mode) => forDepth.includes(mode));
}

const FENCED_CODE = /```|~~~/;

/**
 * Turn model output into a stored lesson, or throw `OutputValidationError`. Structural problems reject
 * the whole lesson: a lesson missing its checks or answer key cannot be taught safely.
 */
export function validateLessonOutput(
  output: LessonOutput,
  input: {
    concept: CurriculumConcept;
    depth: LessonDepth;
    evidence: LessonEvidence[];
    config?: LessonGeneratorConfig;
  },
): LessonContent {
  const config = input.config ?? defaultLessonGeneratorConfig;
  const { concept, depth } = input;
  const issues = new Set<string>();
  const fail = (code: string) => issues.add(code);
  const evidenceIds = new Set(input.evidence.map((item) => item.id));
  const objectives = concept.learningObjectives;
  const modes = allowedModes(concept, depth);

  const text = (value: string, max: number, code: string) => {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > max) fail(code);
    if (FENCED_CODE.test(trimmed)) fail("fenced_code_in_text");
    return trimmed;
  };
  const checkEvidence = (ids: string[]) => {
    if (ids.some((id) => !evidenceIds.has(id))) fail("unknown_evidence_id");
    return [...new Set(ids)];
  };
  const objectiveAt = (index: number) => {
    const objective = objectives[index];
    if (objective === undefined) fail("unknown_objective_index");
    return objective ?? "";
  };

  const title = text(output.title, config.maxTitleChars, "invalid_title");
  const rationale = text(output.rationale, config.maxBodyChars, "invalid_rationale");
  const objectiveIndexes = [...new Set(output.objectiveIndexes)];
  if (objectiveIndexes.length === 0) fail("no_objectives");
  const lessonObjectives = objectiveIndexes.map(objectiveAt);

  const { steps } = output;
  if (steps.length < config.minSteps || steps.length > config.maxSteps) fail("step_count");
  if (steps[0]?.type !== "explanation") fail("first_step_not_explanation");
  if (steps.at(-1)?.type !== "takeaway") fail("last_step_not_takeaway");
  if (steps.filter((step) => step.type === "takeaway").length !== 1) fail("takeaway_count");

  const assessments = steps.filter(
    (step) => step.type === "multiple_choice" || step.type === "open_response",
  );
  if (assessments.length < config.minAssessments || assessments.length > config.maxAssessments) {
    fail("assessment_count");
  }
  for (const step of assessments) if (!modes.includes(step.mode)) fail("mode_not_allowed");

  const openResponses = assessments.filter((step) => step.type === "open_response");
  const objectiveModesAvailable = modes.some((mode) =>
    (OBJECTIVE_MODES as readonly string[]).includes(mode),
  );
  if (depth === "intro" && objectiveModesAvailable && openResponses.length > 1) {
    fail("too_many_open_responses_for_intro");
  }
  const openModesAvailable = modes.some((mode) =>
    (OPEN_RESPONSE_MODES as readonly string[]).includes(mode),
  );
  if (depth === "defense" && openModesAvailable && openResponses.length === 0) {
    fail("defense_without_open_response");
  }
  if (!steps.some((step) => step.type === "explanation" && step.evidenceIds.length > 0)) {
    fail("no_code_focus_step");
  }

  const contentSteps: LessonStep[] = steps.map((step): LessonStep => {
    switch (step.type) {
      case "explanation":
        return {
          type: "explanation",
          title: text(step.title, config.maxTitleChars, "invalid_step_title"),
          body: text(step.body, config.maxBodyChars, "invalid_step_body"),
          evidenceIds: checkEvidence(step.evidenceIds),
        };
      case "multiple_choice": {
        const choices = step.choices.map((choice) => ({
          id: choice.id.trim(),
          text: text(choice.text, config.maxChoiceChars, "invalid_choice"),
        }));
        const ids = new Set(choices.map((choice) => choice.id));
        if (choices.length < config.minChoices || choices.length > config.maxChoices) {
          fail("choice_count");
        }
        if (ids.size !== choices.length || ids.has("")) fail("duplicate_choice_id");
        if (!ids.has(step.correctChoiceId.trim())) fail("correct_choice_missing");
        return {
          type: "multiple_choice",
          mode: step.mode,
          prompt: text(step.prompt, config.maxPromptChars, "invalid_prompt"),
          evidenceIds: checkEvidence(step.evidenceIds),
          choices,
          correctChoiceId: step.correctChoiceId.trim(),
          explanation: text(step.explanation, config.maxBodyChars, "invalid_explanation"),
          objective: objectiveAt(step.objectiveIndex),
        };
      }
      case "open_response": {
        if (step.rubric.length === 0 || step.rubric.length > config.maxRubricCriteria) {
          fail("rubric_size");
        }
        if (step.rubric.some((item) => !(item.weight > 0) || !Number.isFinite(item.weight))) {
          fail("rubric_weight");
        }
        const total = step.rubric.reduce(
          (sum, item) => sum + (Number.isFinite(item.weight) ? item.weight : 0),
          0,
        );
        const rubric = step.rubric.map((item) => {
          const signals = item.expectedSignals.map((signal) => signal.trim()).filter(Boolean);
          if (signals.length === 0) fail("rubric_without_signals");
          return {
            criterion: text(item.criterion, config.maxChoiceChars, "invalid_criterion"),
            weight: total > 0 ? Math.round((item.weight / total) * 10_000) / 10_000 : 0,
            expectedSignals: signals,
          };
        });
        return {
          type: "open_response",
          mode: step.mode,
          prompt: text(step.prompt, config.maxPromptChars, "invalid_prompt"),
          evidenceIds: checkEvidence(step.evidenceIds),
          rubric,
          exemplarSummary: text(step.exemplarSummary, config.maxBodyChars, "invalid_exemplar"),
          objective: objectiveAt(step.objectiveIndex),
        };
      }
      case "takeaway": {
        const points = step.points.map((point) =>
          text(point, config.maxPointChars, "invalid_takeaway_point"),
        );
        if (points.length === 0 || points.length > config.maxTakeawayPoints) {
          fail("takeaway_point_count");
        }
        return { type: "takeaway", points };
      }
    }
  });

  if (issues.size > 0) {
    throw new OutputValidationError([...issues].sort(), {
      steps: steps.length,
      assessments: assessments.length,
      openResponses: openResponses.length,
    });
  }
  return {
    title,
    estimatedMinutes: Math.min(
      config.maxMinutes,
      Math.max(config.minMinutes, Math.round(output.estimatedMinutes)),
    ),
    depth,
    rationale,
    objectives: lessonObjectives,
    steps: contentSteps,
    evidence: input.evidence,
  };
}

export interface GradedCriterion {
  criterion: string;
  weight: number;
  met: CriterionResult;
  evidenceFromAnswer: string;
  /** False when a yes/partial result's quote does not appear in the answer. */
  verified: boolean;
}

export interface GradedResponse {
  score: number;
  /** Confidence after quote verification; what the mastery update uses. */
  graderConfidence: number;
  reportedConfidence: number;
  criterionResults: GradedCriterion[];
  feedback: string;
  misconceptionConceptIds: string[];
}

/** Lowercase word tokens, so quotes match regardless of punctuation, quotation marks, or spacing. */
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/** True when every fragment of the quote (split at ellipses) appears as consecutive words in the answer. */
export function quoteAppearsInAnswer(quote: string, answer: string): boolean {
  const answerWords = words(answer);
  const fragments = quote
    .split(/\.{3}|…/)
    .map(words)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;
  return fragments.every((fragment) => containsSequence(answerWords, fragment));
}

/**
 * Check a grade against the stored rubric and the learner's answer, then compute the score from the
 * criteria (D25). Missing or duplicate criteria reject the grade.
 */
export function validateGraderOutput(
  output: GraderOutput,
  input: {
    step: OpenResponseStep;
    answer: string;
    graph: CurriculumGraph;
    learningConfig?: LearningConfig;
    config?: GraderConfig;
  },
): GradedResponse {
  const config = input.config ?? defaultGraderConfig;
  const { rubric } = input.step;
  const issues: string[] = [];

  const byIndex = new Map<number, GraderOutput["criterionResults"][number]>();
  for (const result of output.criterionResults) {
    if (byIndex.has(result.criterionIndex)) issues.push("duplicate_criterion");
    byIndex.set(result.criterionIndex, result);
  }
  if (byIndex.size !== rubric.length || rubric.some((_, index) => !byIndex.has(index))) {
    issues.push("criteria_mismatch");
  }
  if (!Number.isFinite(output.graderConfidence)) issues.push("invalid_confidence");
  const feedback = output.feedback.trim();
  if (feedback === "") issues.push("empty_feedback");
  if (issues.length > 0) throw new OutputValidationError([...new Set(issues)].sort());

  const criterionResults = rubric.map((item, index): GradedCriterion => {
    const result = byIndex.get(index)!;
    const quote = result.evidenceFromAnswer.trim();
    const verified = result.met === "no" || quoteAppearsInAnswer(quote, input.answer);
    return {
      criterion: item.criterion,
      weight: item.weight,
      met: result.met,
      evidenceFromAnswer: quote,
      verified,
    };
  });
  const unverified = criterionResults.filter((result) => !result.verified).length;

  return {
    score: scoreFromCriteria(criterionResults, input.learningConfig),
    graderConfidence: verifiedGraderConfidence(
      output.graderConfidence,
      unverified,
      input.learningConfig,
    ),
    reportedConfidence: Math.min(1, Math.max(0, output.graderConfidence)),
    criterionResults,
    feedback:
      feedback.length > config.maxFeedbackChars
        ? `${feedback.slice(0, config.maxFeedbackChars - 1).trimEnd()}…`
        : feedback,
    misconceptionConceptIds: [...new Set(output.misconceptionConceptIds)].filter((id) =>
      input.graph.has(id),
    ),
  };
}
