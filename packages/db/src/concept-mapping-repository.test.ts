import { getCurriculum } from "@academy/curriculum";
import type { MappedConcept } from "@academy/learning";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./client";
import {
  CONCEPT_MAPPING_QUEUE,
  completeMappingRun,
  getConceptMappingForUser,
  getMappingRunForWorker,
  markMappingRunFailed,
  markMappingRunRunning,
  scheduleConceptMapping,
  scheduleConceptMappingForUser,
} from "./concept-mapping-repository";
import { importCurriculum } from "./curriculum-repository";
import {
  linkVerifiedUserInstallation,
  markAnalysisRunning,
  markAnalysisSucceeded,
  markInstallationDeleted,
  requestAnalysis,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
} from "./github-repository";
import { conceptMappingRuns, jobs, users } from "./schema";
import { createTestDatabase } from "./testing";

const { graph } = getCurriculum();
const versions = { mapperVersion: "mapper-test", curriculumVersion: graph.version };

let handle: DatabaseHandle;
let nextId = 30_000;

beforeAll(async () => {
  handle = await createTestDatabase();
  await importCurriculum(handle.db, graph.curriculum);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function createUser(): Promise<string> {
  const [user] = await handle.db
    .insert(users)
    .values({ name: "Dev", email: `${crypto.randomUUID()}@example.test` })
    .returning();
  return user!.id;
}

/** A user who can see one pull request with an analysis (succeeded unless told otherwise). */
async function seedAnalysis(options: { succeeded?: boolean } = {}) {
  const userId = await createUser();
  const installationId = nextId++;
  const repositoryId = nextId++;
  await upsertInstallation(handle.db, {
    id: installationId,
    accountLogin: "acme",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId, installationId });
  await syncInstallationRepositories(handle.db, installationId, [
    {
      id: repositoryId,
      owner: "acme",
      name: `repo-${repositoryId}`,
      fullName: `acme/repo-${repositoryId}`,
      defaultBranch: "main",
      private: true,
    },
  ]);
  const pr = await upsertPullRequest(handle.db, repositoryId, {
    number: 7,
    title: "Add retries",
    authorLogin: "octocat",
    baseRef: "main",
    headRef: "feature/retries",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "open",
    githubUpdatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  const requested = await requestAnalysis(handle.db, {
    userId,
    pullRequestId: pr.id,
    analyzerVersion: "context-v1",
  });
  if (requested.status !== "created") throw new Error("analysis not created");
  const analysisId = requested.analysis.id;
  if (options.succeeded !== false) {
    await markAnalysisRunning(handle.db, analysisId);
    await markAnalysisSucceeded(handle.db, analysisId, {
      context: { stub: true },
      estimatedTokens: 1,
    });
  }
  return { userId, installationId, analysisId };
}

async function mappingJobsFor(runId: string) {
  const rows = await handle.db.select().from(jobs).where(eq(jobs.queue, CONCEPT_MAPPING_QUEUE));
  return rows.filter((row) => (row.payload as { runId?: string }).runId === runId);
}

async function runStatus(runId: string) {
  const [run] = await handle.db
    .select()
    .from(conceptMappingRuns)
    .where(eq(conceptMappingRuns.id, runId));
  return run!;
}

const mapping = (conceptId: string, relevance = 0.8): MappedConcept => ({
  conceptId,
  relevance,
  significance: 0.7,
  suggestedDepth: "applied",
  evidence: [
    { path: "src/charge.ts", excerpt: "withRetry(charge)", rationale: "Retries a charge." },
  ],
});

const completion = (mappings: MappedConcept[]) => ({
  mappings,
  dropped: { unknown_concept: 1 },
  provider: "scripted",
  model: "scripted-model",
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 7,
});

describe("scheduleConceptMapping", () => {
  it("creates one run and one job, however often it is called", async () => {
    const { analysisId } = await seedAnalysis();
    const first = await scheduleConceptMapping(handle.db, { analysisId, ...versions });
    const second = await scheduleConceptMapping(handle.db, { analysisId, ...versions });

    expect(first.status).toBe("scheduled");
    expect(second.status).toBe("existing");
    if (first.status !== "scheduled" || second.status !== "existing") return;
    expect(second.run.id).toBe(first.run.id);
    expect(await mappingJobsFor(first.run.id)).toHaveLength(1);
  });

  it("waits for a succeeded analysis and an imported curriculum", async () => {
    const pending = await seedAnalysis({ succeeded: false });
    expect(
      await scheduleConceptMapping(handle.db, { analysisId: pending.analysisId, ...versions }),
    ).toEqual({ status: "analysis_not_ready" });

    const ready = await seedAnalysis();
    expect(
      await scheduleConceptMapping(handle.db, {
        analysisId: ready.analysisId,
        mapperVersion: "mapper-test",
        curriculumVersion: 999,
      }),
    ).toEqual({ status: "curriculum_not_imported" });
  });

  it("treats malformed and unknown analysis IDs as not found", async () => {
    expect(await scheduleConceptMapping(handle.db, { analysisId: "nope", ...versions })).toEqual({
      status: "not_found",
    });
    expect(
      await scheduleConceptMapping(handle.db, { analysisId: crypto.randomUUID(), ...versions }),
    ).toEqual({ status: "not_found" });
  });

  it("requeues a failed run with exactly one retry job per failure", async () => {
    const { analysisId } = await seedAnalysis();
    const created = await scheduleConceptMapping(handle.db, { analysisId, ...versions });
    if (created.status !== "scheduled") throw new Error("not scheduled");
    const runId = created.run.id;
    await markMappingRunRunning(handle.db, runId);
    await markMappingRunFailed(handle.db, runId, "rate_limited");

    const retry = await scheduleConceptMapping(handle.db, { analysisId, ...versions });
    const again = await scheduleConceptMapping(handle.db, { analysisId, ...versions });
    expect(retry.status).toBe("scheduled");
    expect(again.status).toBe("existing");
    expect(await runStatus(runId)).toMatchObject({ status: "queued", errorCode: null });
    expect(await mappingJobsFor(runId)).toHaveLength(2);
  });
});

describe("scheduleConceptMappingForUser", () => {
  it("only schedules analyses the user can see", async () => {
    const owner = await seedAnalysis();
    const stranger = await createUser();
    expect(
      await scheduleConceptMappingForUser(handle.db, {
        userId: stranger,
        analysisId: owner.analysisId,
        ...versions,
      }),
    ).toEqual({ status: "not_found" });
    const result = await scheduleConceptMappingForUser(handle.db, {
      userId: owner.userId,
      analysisId: owner.analysisId,
      ...versions,
    });
    expect(result.status).toBe("scheduled");
  });
});

describe("mapping run lifecycle", () => {
  async function scheduledRun() {
    const seeded = await seedAnalysis();
    const result = await scheduleConceptMapping(handle.db, {
      analysisId: seeded.analysisId,
      ...versions,
    });
    if (result.status !== "scheduled") throw new Error("not scheduled");
    return { ...seeded, runId: result.run.id };
  }

  it("loads a run with its analysis for the worker", async () => {
    const { runId, analysisId } = await scheduledRun();
    const access = await getMappingRunForWorker(handle.db, runId);
    expect(access?.run.id).toBe(runId);
    expect(access?.analysis.id).toBe(analysisId);
    expect(await getMappingRunForWorker(handle.db, "not-a-uuid")).toBeNull();
    expect(await getMappingRunForWorker(handle.db, crypto.randomUUID())).toBeNull();
  });

  it("stores mappings in order only for a running run, with telemetry", async () => {
    const { runId, userId, analysisId } = await scheduledRun();
    expect(await completeMappingRun(handle.db, runId, completion([mapping("web.retries")]))).toBe(
      false,
    );

    await markMappingRunRunning(handle.db, runId);
    const mappings = [mapping("web.idempotency", 0.9), mapping("web.retries", 0.6)];
    expect(await completeMappingRun(handle.db, runId, completion(mappings))).toBe(true);

    const view = await getConceptMappingForUser(handle.db, userId, analysisId, versions);
    expect(view?.mappings).toEqual(mappings);
    expect(view?.run).toMatchObject({
      status: "succeeded",
      provider: "scripted",
      model: "scripted-model",
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 7,
      dropped: { unknown_concept: 1 },
    });
    expect(await markMappingRunFailed(handle.db, runId, "provider_error")).toBe(false);
  });

  it("refuses concept IDs outside the run's curriculum, leaving the run unfinished", async () => {
    const { runId } = await scheduledRun();
    await markMappingRunRunning(handle.db, runId);
    await expect(
      completeMappingRun(handle.db, runId, completion([mapping("web.not-a-concept")])),
    ).rejects.toThrow();
    expect((await runStatus(runId)).status).toBe("running");
  });

  it("hides mappings from other users and after access is removed", async () => {
    const { runId, userId, analysisId, installationId } = await scheduledRun();
    await markMappingRunRunning(handle.db, runId);
    await completeMappingRun(handle.db, runId, completion([mapping("web.retries")]));

    const stranger = await createUser();
    expect(await getConceptMappingForUser(handle.db, stranger, analysisId, versions)).toBeNull();
    expect(
      await getConceptMappingForUser(handle.db, userId, analysisId, {
        ...versions,
        mapperVersion: "mapper-other",
      }),
    ).toBeNull();

    await markInstallationDeleted(handle.db, installationId);
    expect(await getConceptMappingForUser(handle.db, userId, analysisId, versions)).toBeNull();
  });
});
