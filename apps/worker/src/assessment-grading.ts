import {
  GRADER_VERSION,
  ModelCallError,
  OutputValidationError,
  gradeOpenResponse,
  lessonContentSchema,
  type StructuredModel,
} from "@academy/ai";
import type { CurriculumGraph } from "@academy/curriculum";
import {
  getAttemptForWorker,
  markAttemptFailed,
  recordAttemptGrade,
  type AssessmentGradingJobPayload,
  type Database,
} from "@academy/db";
import type { JobHandler, Logger } from "@academy/shared";

/**
 * Grades one open-response attempt against the rubric stored with its lesson and records the mastery
 * event. Safe to run more than once: a graded attempt is left alone, and the mastery event is recorded
 * once per attempt. Learner answers are never logged.
 */
export function createAssessmentGradingHandler(deps: {
  db: Database;
  model: StructuredModel;
  graph: CurriculumGraph;
  log: Logger;
}): JobHandler<AssessmentGradingJobPayload> {
  const { db, model, graph, log } = deps;

  return async (payload, { jobId, attempt: jobAttempt }) => {
    const access = await getAttemptForWorker(db, payload.attemptId);
    if (!access) {
      log.warn("assessment attempt not found", { jobId, attemptId: payload.attemptId });
      return;
    }
    const { attempt, lesson, session } = access;
    if (attempt.status === "graded" || attempt.responseKind !== "text") return;

    const fail = async (errorCode: string, extra: Record<string, unknown> = {}) => {
      await markAttemptFailed(db, attempt.id, errorCode);
      log.warn("grading failed", {
        jobId,
        attempt: jobAttempt,
        attemptId: attempt.id,
        errorCode,
        ...extra,
      });
    };
    if (lesson.curriculumVersion !== graph.version) return fail("curriculum_version_mismatch");
    const concept = graph.get(lesson.conceptId);
    const content = lessonContentSchema.safeParse(lesson.content);
    if (!concept || !content.success) return fail("lesson_invalid");
    const step = content.data.steps[attempt.stepIndex];
    if (step?.type !== "open_response") return fail("step_mismatch");
    const answer = (attempt.response as { text?: unknown }).text;
    if (typeof answer !== "string") return fail("response_invalid");

    try {
      const { graded, call } = await gradeOpenResponse({
        model,
        concept,
        graph,
        step,
        evidence: content.data.evidence,
        answer,
      });
      await recordAttemptGrade(db, {
        attemptId: attempt.id,
        userId: attempt.userId,
        sessionId: session.id,
        conceptId: lesson.conceptId,
        curriculumVersion: lesson.curriculumVersion,
        score: graded.score,
        graderConfidence: graded.graderConfidence,
        grading: { ...graded },
        graderProvider: call.provider,
        graderModel: call.model,
        graderVersion: GRADER_VERSION,
      });
      log.info("attempt graded", {
        jobId,
        attemptId: attempt.id,
        lessonId: lesson.id,
        score: graded.score,
        graderConfidence: graded.graderConfidence,
        model: call.model,
        durationMs: call.durationMs,
      });
    } catch (error) {
      const errorCode = error instanceof ModelCallError ? error.code : "grading_error";
      const issues =
        error instanceof ModelCallError && error.cause instanceof OutputValidationError
          ? error.cause.issues
          : undefined;
      await fail(errorCode, { issues });
      if (error instanceof ModelCallError && !error.retryable) return;
      throw Object.assign(new Error("grading failed"), { code: errorCode });
    }
  };
}
