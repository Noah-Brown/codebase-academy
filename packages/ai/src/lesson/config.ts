import { MAX_ANSWER_CHARS } from "./content";

/** Structural limits for generated lessons and graded answers. */
export interface LessonGeneratorConfig {
  minSteps: number;
  maxSteps: number;
  /** Brief §6: two or three assessment interactions. */
  minAssessments: number;
  maxAssessments: number;
  minChoices: number;
  maxChoices: number;
  maxRubricCriteria: number;
  minMinutes: number;
  maxMinutes: number;
  maxTitleChars: number;
  maxBodyChars: number;
  maxPromptChars: number;
  maxChoiceChars: number;
  maxTakeawayPoints: number;
  maxPointChars: number;
  /** Extra calls allowed to fix a draft that fails structural validation. */
  repairAttempts: number;
}

export const defaultLessonGeneratorConfig: Readonly<LessonGeneratorConfig> = Object.freeze({
  minSteps: 4,
  maxSteps: 8,
  minAssessments: 2,
  maxAssessments: 3,
  minChoices: 3,
  maxChoices: 5,
  maxRubricCriteria: 4,
  minMinutes: 3,
  maxMinutes: 15,
  maxTitleChars: 140,
  maxBodyChars: 1_800,
  maxPromptChars: 800,
  maxChoiceChars: 320,
  maxTakeawayPoints: 5,
  maxPointChars: 300,
  repairAttempts: 1,
});

export interface GraderConfig {
  /** Longer answers are rejected before grading. */
  maxAnswerChars: number;
  maxFeedbackChars: number;
}

export const defaultGraderConfig: Readonly<GraderConfig> = Object.freeze({
  maxAnswerChars: MAX_ANSWER_CHARS,
  maxFeedbackChars: 1_500,
});
