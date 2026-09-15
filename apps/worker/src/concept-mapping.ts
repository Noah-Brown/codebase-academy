import { ModelCallError, mapConcepts, type StructuredModel } from "@academy/ai";
import type { CurriculumGraph } from "@academy/curriculum";
import {
  completeMappingRun,
  getMappingRunForWorker,
  markMappingRunFailed,
  markMappingRunRunning,
  type ConceptMappingJobPayload,
  type Database,
} from "@academy/db";
import { analysisContextSchema } from "@academy/github";
import type { JobHandler, Logger } from "@academy/shared";

/**
 * Maps one analysis context to curriculum concepts. Safe to run more than once: a succeeded run is
 * left alone. Provider failures that a retry could fix are rethrown so the queue backs off and
 * retries; the rest fail the run for the user to retry.
 */
export function createConceptMappingHandler(deps: {
  db: Database;
  model: StructuredModel;
  graph: CurriculumGraph;
  log: Logger;
}): JobHandler<ConceptMappingJobPayload> {
  const { db, model, graph, log } = deps;

  return async (payload, { jobId, attempt }) => {
    const access = await getMappingRunForWorker(db, payload.runId);
    if (!access) {
      log.warn("mapping run not found", { jobId, runId: payload.runId });
      return;
    }
    const { run, analysis } = access;
    if (run.status === "succeeded") return;

    const fail = async (errorCode: string) => {
      await markMappingRunFailed(db, run.id, errorCode);
      log.warn("concept mapping failed", { jobId, attempt, runId: run.id, errorCode });
    };
    if (run.curriculumVersion !== graph.version) return fail("curriculum_version_mismatch");
    if (analysis.status !== "succeeded") return fail("analysis_not_ready");
    const context = analysisContextSchema.safeParse(analysis.context);
    if (!context.success) return fail("context_invalid");

    if (!(await markMappingRunRunning(db, run.id))) return;

    try {
      const result = await mapConcepts({ model, context: context.data, graph });
      const usage = result.call?.usage;
      // Every prompt token, including those read from or written to the provider's prompt cache.
      const inputTokens = usage
        ? usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
        : null;
      await completeMappingRun(db, run.id, {
        mappings: result.mappings,
        dropped: result.dropped,
        provider: result.call?.provider ?? null,
        model: result.call?.model ?? null,
        inputTokens,
        outputTokens: result.call?.usage.outputTokens ?? null,
        durationMs: result.call?.durationMs ?? null,
      });
      log.info("concept mapping succeeded", {
        jobId,
        attempt,
        runId: run.id,
        mappings: result.mappings.length,
        dropped: Object.fromEntries(
          Object.entries(result.dropped).filter(([, count]) => count > 0),
        ),
        skippedReason: result.skippedReason,
        model: result.call?.model ?? null,
        inputTokens,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        outputTokens: result.call?.usage.outputTokens ?? null,
        durationMs: result.call?.durationMs ?? null,
      });
    } catch (error) {
      const errorCode = error instanceof ModelCallError ? error.code : "mapping_failed";
      await fail(errorCode);
      if (error instanceof ModelCallError && !error.retryable) return;
      throw Object.assign(new Error("concept mapping failed"), { code: errorCode });
    }
  };
}
