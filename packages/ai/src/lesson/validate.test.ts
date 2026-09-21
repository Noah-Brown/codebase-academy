import { getCurriculum } from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import type { OpenResponseStep } from "./content";
import {
  idempotencyEvidence,
  idempotencyGraderOutput,
  idempotencyLessonOutput,
  strongIdempotencyAnswer,
} from "./fixtures";
import type { GraderOutput, LessonOutput } from "./schema";
import {
  OutputValidationError,
  allowedModes,
  quoteAppearsInAnswer,
  validateGraderOutput,
  validateLessonOutput,
} from "./validate";

const { graph } = getCurriculum();
const concept = graph.require("web.idempotency");
type Step = LessonOutput["steps"][number];

const validate = (
  output: LessonOutput,
  depth: "intro" | "applied" | "advanced" | "defense" = "advanced",
) => validateLessonOutput(output, { concept, depth, evidence: idempotencyEvidence });

const issuesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof OutputValidationError) return error.issues;
    throw error;
  }
  return [];
};

const withSteps = (steps: Step[]): LessonOutput => ({ ...idempotencyLessonOutput, steps });
const [intro, focus, choice, open, takeaway] = idempotencyLessonOutput.steps as [
  Extract<Step, { type: "explanation" }>,
  Extract<Step, { type: "explanation" }>,
  Extract<Step, { type: "multiple_choice" }>,
  Extract<Step, { type: "open_response" }>,
  Extract<Step, { type: "takeaway" }>,
];

describe("allowedModes", () => {
  it("intersects the concept's canonical modes with what the depth allows", () => {
    expect(allowedModes(concept, "intro")).toEqual(["predict", "explain"]);
    expect(allowedModes(concept, "advanced")).toEqual(["predict", "explain", "compare", "design"]);
    expect(allowedModes(concept, "defense")).toEqual([
      "predict",
      "explain",
      "compare",
      "design",
      "defend",
    ]);
  });
});

describe("validateLessonOutput", () => {
  it("turns a well-formed lesson into stored content", () => {
    const content = validate(idempotencyLessonOutput);
    expect(content.depth).toBe("advanced");
    expect(content.objectives).toEqual([
      concept.learningObjectives[0],
      concept.learningObjectives[2],
    ]);
    const openStep = content.steps[3] as OpenResponseStep;
    expect(openStep.rubric.map((item) => item.weight)).toEqual([0.6667, 0.3333]);
    expect(openStep.objective).toBe(concept.learningObjectives[2]);
    expect(content.evidence).toEqual(idempotencyEvidence);
  });

  it("clamps the estimate into the allowed range", () => {
    expect(validate({ ...idempotencyLessonOutput, estimatedMinutes: 45 }).estimatedMinutes).toBe(
      15,
    );
    expect(validate({ ...idempotencyLessonOutput, estimatedMinutes: 1 }).estimatedMinutes).toBe(3);
  });

  it("requires an opening explanation, one closing takeaway, and a code focus step", () => {
    expect(issuesOf(() => validate(withSteps([choice, focus, open, takeaway])))).toContain(
      "first_step_not_explanation",
    );
    expect(issuesOf(() => validate(withSteps([intro, focus, choice, open])))).toEqual(
      expect.arrayContaining(["last_step_not_takeaway", "takeaway_count"]),
    );
    expect(
      issuesOf(() =>
        validate(withSteps([intro, { ...focus, evidenceIds: [] }, choice, open, takeaway])),
      ),
    ).toContain("no_code_focus_step");
  });

  it("requires two or three assessments in allowed modes", () => {
    expect(issuesOf(() => validate(withSteps([intro, focus, choice, takeaway])))).toContain(
      "assessment_count",
    );
    expect(
      issuesOf(() => validate(withSteps([intro, focus, choice, choice, open, open, takeaway]))),
    ).toContain("assessment_count");
    expect(
      issuesOf(() =>
        validate(withSteps([intro, focus, { ...open, mode: "defend" }, choice, takeaway])),
      ),
    ).toContain("mode_not_allowed");
    expect(
      issuesOf(() =>
        validate(withSteps([intro, focus, { ...choice, mode: "recognize" }, open, takeaway])),
      ),
    ).toContain("mode_not_allowed");
  });

  it("applies depth rules to open responses", () => {
    const explainOpen = { ...open, mode: "explain" as const };
    expect(
      issuesOf(() =>
        validate(withSteps([intro, focus, explainOpen, explainOpen, takeaway]), "intro"),
      ),
    ).toContain("too_many_open_responses_for_intro");
    expect(
      issuesOf(() =>
        validate(
          withSteps([intro, focus, choice, { ...choice, prompt: "Another prediction?" }, takeaway]),
          "defense",
        ),
      ),
    ).toContain("defense_without_open_response");
  });

  it("checks evidence IDs, objectives, and choices", () => {
    const issues = issuesOf(() =>
      validate(
        withSteps([
          intro,
          { ...focus, evidenceIds: ["e9"] },
          {
            ...choice,
            choices: [
              { id: "a", text: "One" },
              { id: "a", text: "Two" },
            ],
            correctChoiceId: "z",
            objectiveIndex: 7,
          },
          open,
          takeaway,
        ]),
      ),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "unknown_evidence_id",
        "unknown_objective_index",
        "choice_count",
        "duplicate_choice_id",
        "correct_choice_missing",
      ]),
    );
  });

  it("checks rubrics", () => {
    const issues = issuesOf(() =>
      validate(
        withSteps([
          intro,
          focus,
          choice,
          {
            ...open,
            rubric: [
              { criterion: "Names a key", weight: 0, expectedSignals: [] },
              { criterion: "Names a race", weight: 1, expectedSignals: ["  "] },
            ],
          },
          takeaway,
        ]),
      ),
    );
    expect(issues).toEqual(expect.arrayContaining(["rubric_weight", "rubric_without_signals"]));
  });

  it("rejects fenced code, so code appears only as verified evidence", () => {
    const issues = issuesOf(() =>
      validate(
        withSteps([
          intro,
          { ...focus, body: "Here is a fix:\n```ts\nawait charge({ idempotencyKey })\n```" },
          choice,
          open,
          takeaway,
        ]),
      ),
    );
    expect(issues).toContain("fenced_code_in_text");
  });
});

describe("validateGraderOutput", () => {
  const step = validate(idempotencyLessonOutput).steps[3] as OpenResponseStep;
  const grade = (output: GraderOutput, answer = strongIdempotencyAnswer) =>
    validateGraderOutput(output, { step, answer, graph });

  it("computes the score from the criteria and keeps verified confidence", () => {
    const graded = grade(idempotencyGraderOutput);
    expect(graded.score).toBeCloseTo(0.8333, 3);
    expect(graded.graderConfidence).toBe(0.9);
    expect(graded.criterionResults.every((result) => result.verified)).toBe(true);
    expect(graded.criterionResults[0]).toMatchObject({
      criterion: step.rubric[0]!.criterion,
      weight: step.rubric[0]!.weight,
      met: "yes",
    });
  });

  it("halves confidence for each credited quote that is not in the answer", () => {
    const graded = grade({
      ...idempotencyGraderOutput,
      criterionResults: [
        { criterionIndex: 0, met: "yes", evidenceFromAnswer: "use a distributed lock" },
        { criterionIndex: 1, met: "no", evidenceFromAnswer: "" },
      ],
    });
    expect(graded.criterionResults.map((result) => result.verified)).toEqual([false, true]);
    expect(graded.graderConfidence).toBe(0.45);
    expect(graded.reportedConfidence).toBe(0.9);
  });

  it("requires exactly one result per criterion", () => {
    expect(
      issuesOf(() =>
        grade({
          ...idempotencyGraderOutput,
          criterionResults: [idempotencyGraderOutput.criterionResults[0]!],
        }),
      ),
    ).toContain("criteria_mismatch");
    expect(
      issuesOf(() =>
        grade({
          ...idempotencyGraderOutput,
          criterionResults: [
            idempotencyGraderOutput.criterionResults[0]!,
            idempotencyGraderOutput.criterionResults[0]!,
          ],
        }),
      ),
    ).toEqual(expect.arrayContaining(["duplicate_criterion", "criteria_mismatch"]));
  });

  it("drops unknown misconception IDs and requires feedback", () => {
    const graded = grade({
      ...idempotencyGraderOutput,
      misconceptionConceptIds: ["web.retries", "web.retries", "web.not-a-concept"],
    });
    expect(graded.misconceptionConceptIds).toEqual(["web.retries"]);
    expect(issuesOf(() => grade({ ...idempotencyGraderOutput, feedback: "  " }))).toContain(
      "empty_feedback",
    );
  });
});

describe("quote verification", () => {
  const answer =
    'I would send an "idempotency key" with every attempt, so the provider can dedupe; also, check-then-create can race.';

  it("ignores punctuation, quotation marks, case, and spacing", () => {
    expect(quoteAppearsInAnswer("send an idempotency key with every attempt", answer)).toBe(true);
    expect(quoteAppearsInAnswer('"Send an  Idempotency Key"', answer)).toBe(true);
    expect(quoteAppearsInAnswer("check then create can race", answer)).toBe(true);
  });

  it("checks each fragment of a quote joined with an ellipsis", () => {
    expect(quoteAppearsInAnswer("send an idempotency key … can race", answer)).toBe(true);
    expect(quoteAppearsInAnswer("send an idempotency key ... use a lock", answer)).toBe(false);
  });

  it("rejects paraphrases, reordered words, and empty quotes", () => {
    expect(quoteAppearsInAnswer("use an idempotency token", answer)).toBe(false);
    expect(quoteAppearsInAnswer("key idempotency an send", answer)).toBe(false);
    expect(quoteAppearsInAnswer("  … ", answer)).toBe(false);
  });
});
