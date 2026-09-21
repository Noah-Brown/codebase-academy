import { getCurriculum } from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import { isAssessmentStep, lessonContentSchema, revealFor, toPublicStep } from "./content";
import { idempotencyEvidence, idempotencyLessonOutput } from "./fixtures";
import { validateLessonOutput } from "./validate";

const { graph } = getCurriculum();
const content = validateLessonOutput(idempotencyLessonOutput, {
  concept: graph.require("web.idempotency"),
  depth: "advanced",
  evidence: idempotencyEvidence,
});

describe("lesson content", () => {
  it("round-trips through the stored-content schema", () => {
    expect(lessonContentSchema.parse(JSON.parse(JSON.stringify(content)))).toEqual(content);
  });

  it("never exposes answer keys, explanations, rubrics, or exemplars before an answer", () => {
    const publicSteps = JSON.stringify(content.steps.map(toPublicStep));
    expect(publicSteps).not.toContain("correctChoiceId");
    expect(publicSteps).not.toContain("rubric");
    expect(publicSteps).not.toContain("exemplarSummary");
    for (const step of content.steps.filter(isAssessmentStep)) {
      const hidden = step.type === "multiple_choice" ? step.explanation : step.exemplarSummary;
      expect(publicSteps).not.toContain(hidden);
    }
    expect(publicSteps).toContain("The first attempt times out");
  });

  it("reveals the answer key or rubric only for assessment steps", () => {
    expect(revealFor(content.steps[0]!)).toBeNull();
    expect(revealFor(content.steps[2]!)).toMatchObject({
      type: "multiple_choice",
      correctChoiceId: "a",
    });
    const reveal = revealFor(content.steps[3]!);
    expect(reveal).toMatchObject({ type: "open_response" });
    expect(JSON.stringify(reveal)).not.toContain("weight");
  });
});
