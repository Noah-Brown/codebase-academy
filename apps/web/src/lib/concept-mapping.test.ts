import { getCurriculum } from "@academy/curriculum";
import {
  importCurriculum,
  linkVerifiedUserInstallation,
  markAnalysisRunning,
  markAnalysisSucceeded,
  requestAnalysis,
  schema,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startConceptMapping } from "./concept-mapping";

const { graph } = getCurriculum();
const versions = { mapperVersion: "mapper-test", curriculumVersion: graph.version };

let handle: DatabaseHandle;
let ownerId: string;
let strangerId: string;
let nextPr = 1;

beforeAll(async () => {
  handle = await createTestDatabase();
  await importCurriculum(handle.db, graph.curriculum);
  const [owner, stranger] = await handle.db
    .insert(schema.users)
    .values([
      { name: "Owner", email: "owner@example.test" },
      { name: "Stranger", email: "stranger@example.test" },
    ])
    .returning();
  ownerId = owner!.id;
  strangerId = stranger!.id;
  await upsertInstallation(handle.db, {
    id: 77,
    accountLogin: "acme",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId: ownerId, installationId: 77 });
  await syncInstallationRepositories(handle.db, 77, [
    {
      id: 9001,
      owner: "acme",
      name: "api",
      fullName: "acme/api",
      defaultBranch: "main",
      private: true,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function analysis(succeeded = true): Promise<string> {
  const pr = await upsertPullRequest(handle.db, 9001, {
    number: nextPr++,
    title: "Change",
    authorLogin: "dev",
    baseRef: "main",
    headRef: "feature",
    baseSha: "a".repeat(40),
    headSha: "c".repeat(40),
    state: "open",
    githubUpdatedAt: new Date("2026-09-14T00:00:00Z"),
  });
  const result = await requestAnalysis(handle.db, {
    userId: ownerId,
    pullRequestId: pr.id,
    analyzerVersion: "context-v1",
  });
  if (result.status !== "created") throw new Error("analysis not created");
  if (succeeded) {
    await markAnalysisRunning(handle.db, result.analysis.id);
    await markAnalysisSucceeded(handle.db, result.analysis.id, { context: {}, estimatedTokens: 1 });
  }
  return result.analysis.id;
}

describe("startConceptMapping", () => {
  it("schedules once and returns the same run on repeat", async () => {
    const analysisId = await analysis();
    const first = await startConceptMapping(handle.db, ownerId, analysisId, versions);
    const second = await startConceptMapping(handle.db, ownerId, analysisId, versions);
    expect(first).toMatchObject({ status: 202, body: { status: "queued" } });
    expect(second.body).toEqual(first.body);

    const queued = await handle.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.queue, "concept-mapping"));
    expect(
      queued.filter(
        (job) =>
          (job.payload as { runId: string }).runId === (first.body as { runId: string }).runId,
      ),
    ).toHaveLength(1);
  });

  it("does not reveal another user's analysis", async () => {
    const analysisId = await analysis();
    expect(await startConceptMapping(handle.db, strangerId, analysisId, versions)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  it("reports why mapping cannot start yet", async () => {
    expect(await startConceptMapping(handle.db, ownerId, await analysis(false), versions)).toEqual({
      status: 409,
      body: { error: "analysis_not_ready" },
    });
    expect(
      await startConceptMapping(handle.db, ownerId, await analysis(), {
        ...versions,
        curriculumVersion: 999,
      }),
    ).toEqual({ status: 409, body: { error: "curriculum_not_imported" } });
  });
});
