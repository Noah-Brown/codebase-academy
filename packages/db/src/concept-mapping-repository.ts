import type { MappedConcept } from "@academy/learning";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client";
import { getAnalysisForUser, getAnalysisForWorker, type AnalysisAccess } from "./github-repository";
import { enqueueJob } from "./job-queue";
import { conceptMappingRuns, conceptMappings, curriculumVersions } from "./schema";

export const CONCEPT_MAPPING_QUEUE = "concept-mapping";

export type ConceptMappingRunRow = typeof conceptMappingRuns.$inferSelect;

export interface MappingVersions {
  mapperVersion: string;
  curriculumVersion: number;
}

export interface ConceptMappingJobPayload {
  runId: string;
}

export type ScheduleMappingResult =
  | { status: "scheduled" | "existing"; run: ConceptMappingRunRow }
  | { status: "not_found" | "analysis_not_ready" | "curriculum_not_imported" };

export interface MappingRunAccess extends AnalysisAccess {
  run: ConceptMappingRunRow;
}

export interface ConceptMappingView {
  run: ConceptMappingRunRow;
  mappings: MappedConcept[];
}

export interface CompletedMappingRun {
  mappings: MappedConcept[];
  dropped: Record<string, number>;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findRun(
  db: Database,
  analysisId: string,
  versions: MappingVersions,
): Promise<ConceptMappingRunRow | null> {
  const [run] = await db
    .select()
    .from(conceptMappingRuns)
    .where(
      and(
        eq(conceptMappingRuns.analysisId, analysisId),
        eq(conceptMappingRuns.mapperVersion, versions.mapperVersion),
        eq(conceptMappingRuns.curriculumVersion, versions.curriculumVersion),
      ),
    );
  return run ?? null;
}

async function scheduleForAccess(
  db: Database,
  access: AnalysisAccess,
  versions: MappingVersions,
): Promise<ScheduleMappingResult> {
  if (access.analysis.status !== "succeeded") return { status: "analysis_not_ready" };
  const [imported] = await db
    .select({ version: curriculumVersions.version })
    .from(curriculumVersions)
    .where(eq(curriculumVersions.version, versions.curriculumVersion));
  if (!imported) return { status: "curriculum_not_imported" };

  const [created] = await db
    .insert(conceptMappingRuns)
    .values({ analysisId: access.analysis.id, ...versions })
    .onConflictDoNothing({
      target: [
        conceptMappingRuns.analysisId,
        conceptMappingRuns.mapperVersion,
        conceptMappingRuns.curriculumVersion,
      ],
    })
    .returning();
  if (created) {
    const payload: ConceptMappingJobPayload = { runId: created.id };
    await enqueueJob(db, {
      queue: CONCEPT_MAPPING_QUEUE,
      payload,
      idempotencyKey: `concept-mapping:${created.id}`,
    });
    return { status: "scheduled", run: created };
  }

  const existing = await findRun(db, access.analysis.id, versions);
  if (!existing) return { status: "not_found" };
  if (existing.status !== "failed") return { status: "existing", run: existing };

  // A retry gets its own job keyed on the failure it retries, so a double click enqueues once.
  const [reset] = await db
    .update(conceptMappingRuns)
    .set({ status: "queued", errorCode: null, updatedAt: new Date() })
    .where(and(eq(conceptMappingRuns.id, existing.id), eq(conceptMappingRuns.status, "failed")))
    .returning();
  if (!reset) {
    const current = await findRun(db, access.analysis.id, versions);
    return current ? { status: "existing", run: current } : { status: "not_found" };
  }
  const payload: ConceptMappingJobPayload = { runId: reset.id };
  await enqueueJob(db, {
    queue: CONCEPT_MAPPING_QUEUE,
    payload,
    idempotencyKey: `concept-mapping:${reset.id}:retry:${existing.updatedAt.getTime()}`,
  });
  return { status: "scheduled", run: reset };
}

/**
 * Create (or find) the mapping run for an analysis and make sure a job will process it. For the
 * worker, right after it builds the analysis context. Repeated calls enqueue once; a failed run is
 * reset to queued and gets one retry job per failure.
 */
export async function scheduleConceptMapping(
  db: Database,
  input: { analysisId: string } & MappingVersions,
): Promise<ScheduleMappingResult> {
  if (!UUID_PATTERN.test(input.analysisId)) return { status: "not_found" };
  const access = await getAnalysisForWorker(db, input.analysisId);
  if (!access) return { status: "not_found" };
  return scheduleForAccess(db, access, input);
}

/** `scheduleConceptMapping` for a signed-in user: another user's analysis is simply not found. */
export async function scheduleConceptMappingForUser(
  db: Database,
  input: { userId: string; analysisId: string } & MappingVersions,
): Promise<ScheduleMappingResult> {
  const access = await getAnalysisForUser(db, input.userId, input.analysisId);
  if (!access) return { status: "not_found" };
  return scheduleForAccess(db, access, input);
}

export async function getMappingRunForWorker(
  db: Database,
  runId: string,
): Promise<MappingRunAccess | null> {
  if (!UUID_PATTERN.test(runId)) return null;
  const [run] = await db.select().from(conceptMappingRuns).where(eq(conceptMappingRuns.id, runId));
  if (!run) return null;
  const access = await getAnalysisForWorker(db, run.analysisId);
  return access ? { ...access, run } : null;
}

/** Claims a run for processing. A running run may be reclaimed after a worker crash. */
export async function markMappingRunRunning(db: Database, runId: string): Promise<boolean> {
  const rows = await db
    .update(conceptMappingRuns)
    .set({ status: "running", errorCode: null, startedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(conceptMappingRuns.id, runId),
        inArray(conceptMappingRuns.status, ["queued", "running", "failed"]),
      ),
    )
    .returning({ id: conceptMappingRuns.id });
  return rows.length > 0;
}

/** Stores the validated mappings and marks the run succeeded, atomically. */
export async function completeMappingRun(
  db: Database,
  runId: string,
  result: CompletedMappingRun,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [run] = await tx
      .update(conceptMappingRuns)
      .set({
        status: "succeeded",
        errorCode: null,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        dropped: result.dropped,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(conceptMappingRuns.id, runId), eq(conceptMappingRuns.status, "running")))
      .returning();
    if (!run) return false;

    await tx.delete(conceptMappings).where(eq(conceptMappings.runId, runId));
    if (result.mappings.length > 0) {
      await tx.insert(conceptMappings).values(
        result.mappings.map((mapping, position) => ({
          runId,
          curriculumVersion: run.curriculumVersion,
          conceptId: mapping.conceptId,
          position,
          relevance: mapping.relevance,
          significance: mapping.significance,
          suggestedDepth: mapping.suggestedDepth,
          evidence: mapping.evidence,
        })),
      );
    }
    return true;
  });
}

/** `errorCode` must be a stable machine code, never a message. */
export async function markMappingRunFailed(
  db: Database,
  runId: string,
  errorCode: string,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(conceptMappingRuns)
    .set({ status: "failed", errorCode, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(conceptMappingRuns.id, runId),
        inArray(conceptMappingRuns.status, ["queued", "running"]),
      ),
    )
    .returning({ id: conceptMappingRuns.id });
  return rows.length > 0;
}

/** The mapping run for one of the user's analyses at the given versions, with its mappings. */
export async function getConceptMappingForUser(
  db: Database,
  userId: string,
  analysisId: string,
  versions: MappingVersions,
): Promise<ConceptMappingView | null> {
  const access = await getAnalysisForUser(db, userId, analysisId);
  if (!access) return null;
  const run = await findRun(db, access.analysis.id, versions);
  if (!run) return null;
  const rows = await db
    .select()
    .from(conceptMappings)
    .where(eq(conceptMappings.runId, run.id))
    .orderBy(asc(conceptMappings.position));
  return {
    run,
    mappings: rows.map((row) => ({
      conceptId: row.conceptId,
      relevance: row.relevance,
      significance: row.significance,
      suggestedDepth: row.suggestedDepth,
      evidence: row.evidence,
    })),
  };
}
