import type { LessonEvidence, PublicLessonStep, StepReveal } from "@academy/ai/lessons";
import type { LessonDepth } from "@academy/learning";

/**
 * What the lesson page sends to the browser. Types only, so client components can import them without
 * pulling server code. Answer keys, rubrics, and exemplars appear only inside a graded attempt's reveal.
 */

export interface CriterionResultView {
  criterion: string;
  met: "yes" | "partial" | "no";
  evidenceFromAnswer: string;
  verified: boolean;
}

export interface AttemptView {
  id: string;
  stepIndex: number;
  status: "grading" | "graded" | "failed";
  errorCode: string | null;
  responseKind: "choice" | "text" | "dont_know";
  /** The learner's own answer, shown back only to them. */
  choiceId: string | null;
  text: string | null;
  score: number | null;
  correct: boolean | null;
  feedback: string | null;
  criterionResults: CriterionResultView[];
  reveal: StepReveal | null;
  flagged: boolean;
  mastery: { applied: boolean; appliedWeight: number; skipReason: string | null } | null;
}

export interface StatusView {
  label: string;
  insufficientEvidence: boolean;
}

export interface LessonHeaderView {
  lessonId: string;
  analysisId: string;
  conceptId: string;
  conceptTitle: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
}

export interface PendingLessonView extends LessonHeaderView {
  status: "queued" | "generating" | "failed";
  errorCode: string | null;
}

export interface ReadyLessonView extends LessonHeaderView {
  status: "ready";
  title: string;
  estimatedMinutes: number;
  depth: LessonDepth;
  rationale: string;
  objectives: string[];
  evidence: LessonEvidence[];
  steps: PublicLessonStep[];
  session: { id: string; status: "active" | "completed"; currentStep: number } | null;
  attempts: AttemptView[];
  /** The learner's status on the concept when the lesson was requested, and now. */
  statusBefore: StatusView;
  statusNow: StatusView;
}

export type LessonView = PendingLessonView | ReadyLessonView;
