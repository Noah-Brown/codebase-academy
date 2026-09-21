import {
  LESSON_DEPTHS,
  MASTERY_LABELS,
  OBJECTIVE_MODES,
  OPEN_RESPONSE_MODES,
  STARTING_LEVELS,
} from "@academy/learning";
import { z } from "zod";

/**
 * The stored lesson contract (milestone-4-design.md). Side-effect free: the web app imports it for
 * types and the public projection without loading provider code.
 */

export const lessonEvidenceSchema = z.object({
  /** "e1", "e2", …: stable within a lesson. */
  id: z.string(),
  path: z.string(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  excerpt: z.string(),
  rationale: z.string(),
});
export type LessonEvidence = z.infer<typeof lessonEvidenceSchema>;

/** What a lesson is generated from, snapshotted when the learner asks for it. */
export const lessonSourcesSchema = z.object({
  pullRequestTitle: z.string(),
  /** The ranker's plain-language reasons for recommending this concept. */
  reasons: z.array(z.string()),
  learner: z.object({
    level: z.enum(STARTING_LEVELS),
    label: z.enum(MASTERY_LABELS),
    insufficientEvidence: z.boolean(),
  }),
  evidence: z.array(lessonEvidenceSchema),
});
export type LessonSources = z.infer<typeof lessonSourcesSchema>;
export type LessonLearner = LessonSources["learner"];

const explanationStep = z.object({
  type: z.literal("explanation"),
  title: z.string(),
  body: z.string(),
  evidenceIds: z.array(z.string()),
});

const multipleChoiceStep = z.object({
  type: z.literal("multiple_choice"),
  mode: z.enum(OBJECTIVE_MODES),
  prompt: z.string(),
  evidenceIds: z.array(z.string()),
  choices: z.array(z.object({ id: z.string(), text: z.string() })),
  correctChoiceId: z.string(),
  explanation: z.string(),
  /** The canonical learning objective this check assesses. */
  objective: z.string(),
});

const openResponseStep = z.object({
  type: z.literal("open_response"),
  mode: z.enum(OPEN_RESPONSE_MODES),
  prompt: z.string(),
  evidenceIds: z.array(z.string()),
  /** Weights sum to 1. */
  rubric: z.array(
    z.object({ criterion: z.string(), weight: z.number(), expectedSignals: z.array(z.string()) }),
  ),
  exemplarSummary: z.string(),
  objective: z.string(),
});

const takeawayStep = z.object({ type: z.literal("takeaway"), points: z.array(z.string()) });

export const lessonStepSchema = z.discriminatedUnion("type", [
  explanationStep,
  multipleChoiceStep,
  openResponseStep,
  takeawayStep,
]);
export type LessonStep = z.infer<typeof lessonStepSchema>;
export type MultipleChoiceStep = z.infer<typeof multipleChoiceStep>;
export type OpenResponseStep = z.infer<typeof openResponseStep>;
export type AssessmentStep = MultipleChoiceStep | OpenResponseStep;

export const lessonContentSchema = z.object({
  title: z.string(),
  estimatedMinutes: z.number().int(),
  depth: z.enum(LESSON_DEPTHS),
  rationale: z.string(),
  objectives: z.array(z.string()),
  steps: z.array(lessonStepSchema),
  evidence: z.array(lessonEvidenceSchema),
});
export type LessonContent = z.infer<typeof lessonContentSchema>;

/** Longest written answer accepted for grading. */
export const MAX_ANSWER_CHARS = 4_000;

export const isAssessmentStep = (step: LessonStep): step is AssessmentStep =>
  step.type === "multiple_choice" || step.type === "open_response";

/** A step as the learner may see it before answering: no answer key, explanation, or rubric. */
export type PublicLessonStep =
  | z.infer<typeof explanationStep>
  | Pick<MultipleChoiceStep, "type" | "mode" | "prompt" | "evidenceIds" | "choices">
  | Pick<OpenResponseStep, "type" | "mode" | "prompt" | "evidenceIds">
  | z.infer<typeof takeawayStep>;

export function toPublicStep(step: LessonStep): PublicLessonStep {
  switch (step.type) {
    case "multiple_choice":
      return {
        type: step.type,
        mode: step.mode,
        prompt: step.prompt,
        evidenceIds: step.evidenceIds,
        choices: step.choices,
      };
    case "open_response":
      return {
        type: step.type,
        mode: step.mode,
        prompt: step.prompt,
        evidenceIds: step.evidenceIds,
      };
    default:
      return step;
  }
}

/** What answering a step unlocks. Sent only after that step's attempt is graded. */
export type StepReveal =
  | { type: "multiple_choice"; correctChoiceId: string; explanation: string }
  | {
      type: "open_response";
      rubric: Array<{ criterion: string; expectedSignals: string[] }>;
      exemplarSummary: string;
    };

export function revealFor(step: LessonStep): StepReveal | null {
  if (step.type === "multiple_choice") {
    return {
      type: step.type,
      correctChoiceId: step.correctChoiceId,
      explanation: step.explanation,
    };
  }
  if (step.type === "open_response") {
    return {
      type: step.type,
      rubric: step.rubric.map(({ criterion, expectedSignals }) => ({ criterion, expectedSignals })),
      exemplarSummary: step.exemplarSummary,
    };
  }
  return null;
}
