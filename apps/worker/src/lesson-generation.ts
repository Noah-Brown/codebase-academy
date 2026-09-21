import {
  ModelCallError,
  OutputValidationError,
  generateLesson,
  lessonSourcesSchema,
  type StructuredModel,
} from "@academy/ai";
import type { CurriculumGraph } from "@academy/curriculum";
import {
  completeLessonGeneration,
  getLessonForWorker,
  markLessonFailed,
  markLessonGenerating,
  type Database,
  type LessonGenerationJobPayload,
} from "@academy/db";
import type { JobHandler, Logger } from "@academy/shared";

/** Issue codes from structural validation are safe to log; they never contain content. */
const issueCodes = (error: unknown) =>
  error instanceof ModelCallError && error.cause instanceof OutputValidationError
    ? error.cause.issues
    : undefined;

/**
 * Generates one requested lesson. Safe to run more than once: a ready lesson is left alone. Failures a
 * retry could fix are rethrown for the queue's backoff; the rest fail the lesson for the learner to retry.
 */
export function createLessonGenerationHandler(deps: {
  db: Database;
  model: StructuredModel;
  graph: CurriculumGraph;
  log: Logger;
}): JobHandler<LessonGenerationJobPayload> {
  const { db, model, graph, log } = deps;

  return async (payload, { jobId, attempt }) => {
    const access = await getLessonForWorker(db, payload.lessonId);
    if (!access) {
      log.warn("lesson not found", { jobId, lessonId: payload.lessonId });
      return;
    }
    const { lesson, pullRequest } = access;
    if (lesson.status === "ready") return;

    const fail = async (errorCode: string, extra: Record<string, unknown> = {}) => {
      await markLessonFailed(db, lesson.id, errorCode);
      log.warn("lesson generation failed", {
        jobId,
        attempt,
        lessonId: lesson.id,
        errorCode,
        ...extra,
      });
    };
    if (lesson.curriculumVersion !== graph.version) return fail("curriculum_version_mismatch");
    const concept = graph.get(lesson.conceptId);
    if (!concept) return fail("unknown_concept");
    const sources = lessonSourcesSchema.safeParse(lesson.sources);
    if (!sources.success) return fail("sources_invalid");

    if (!(await markLessonGenerating(db, lesson.id))) return;

    try {
      const { content, call } = await generateLesson({
        model,
        concept,
        graph,
        depth: lesson.depth,
        learner: sources.data.learner,
        evidence: sources.data.evidence,
        reasons: sources.data.reasons,
        pullRequestTitle: sources.data.pullRequestTitle || pullRequest.title,
      });
      await completeLessonGeneration(db, lesson.id, {
        content,
        provider: call.provider,
        model: call.model,
        inputTokens:
          call.usage.inputTokens +
          call.usage.cacheReadInputTokens +
          call.usage.cacheCreationInputTokens,
        outputTokens: call.usage.outputTokens,
        durationMs: call.durationMs,
      });
      log.info("lesson generated", {
        jobId,
        attempt,
        lessonId: lesson.id,
        steps: content.steps.length,
        model: call.model,
        outputTokens: call.usage.outputTokens,
        durationMs: call.durationMs,
      });
    } catch (error) {
      const errorCode = error instanceof ModelCallError ? error.code : "generation_failed";
      await fail(errorCode, { issues: issueCodes(error) });
      if (error instanceof ModelCallError && !error.retryable) return;
      throw Object.assign(new Error("lesson generation failed"), { code: errorCode });
    }
  };
}
