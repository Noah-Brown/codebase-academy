import { MAPPER_VERSION } from "@academy/ai";
import { createScriptedModel, goldenFixtures, ModelCallError } from "@academy/ai/testing";
import { getCurriculum, type CurriculumGraph } from "@academy/curriculum";
import {
  getConceptMappingForUser,
  importCurriculum,
  linkVerifiedUserInstallation,
  markAnalysisRunning,
  markAnalysisSucceeded,
  requestAnalysis,
  scheduleConceptMapping,
  schema,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import { createLogger } from "@academy/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createConceptMappingHandler } from "./concept-mapping";

const { graph } = getCurriculum();
const versions = { mapperVersion: MAPPER_VERSION, curriculumVersion: graph.version };
const fixture = goldenFixtures.find((f) => f.id === "retry-idempotency")!;
const log = createLogger({ write: () => {} });
const job = { jobId: "job-1", attempt: 1 };

let handle: DatabaseHandle;
let userId: string;
let analysisId: string;
let runId: string;

beforeEach(async () => {
  await handle?.close();
  handle = await createTestDatabase();
  await importCurriculum(handle.db, graph.curriculum);

  const [user] = await handle.db
    .insert(schema.users)
    .values({ name: "Dev", email: "dev@example.test" })
    .returning();
  userId = user!.id;
  await upsertInstallation(handle.db, {
    id: 11,
    accountLogin: "example-org",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId, installationId: 11 });
  await syncInstallationRepositories(handle.db, 11, [
    {
      id: 4242,
      owner: "example-org",
      name: "example-service",
      fullName: "example-org/example-service",
      defaultBranch: "main",
      private: true,
    },
  ]);
  const pr = await upsertPullRequest(handle.db, 4242, {
    number: 12,
    title: fixture.context.pullRequest.title,
    authorLogin: "example-dev",
    baseRef: "main",
    headRef: "feature",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "open",
    githubUpdatedAt: new Date("2026-09-14T09:00:00Z"),
  });
  const requested = await requestAnalysis(handle.db, {
    userId,
    pullRequestId: pr.id,
    analyzerVersion: fixture.context.analyzerVersion,
  });
  if (requested.status !== "created") throw new Error("analysis not created");
  analysisId = requested.analysis.id;
  await markAnalysisRunning(handle.db, analysisId);
  await markAnalysisSucceeded(handle.db, analysisId, {
    context: fixture.context,
    estimatedTokens: fixture.context.budget.estimatedTokens,
  });
  const scheduled = await scheduleConceptMapping(handle.db, { analysisId, ...versions });
  if (scheduled.status !== "scheduled") throw new Error("mapping not scheduled");
  runId = scheduled.run.id;
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function run() {
  const [row] = await handle.db
    .select()
    .from(schema.conceptMappingRuns)
    .where(eq(schema.conceptMappingRuns.id, runId));
  return row!;
}

describe("concept mapping job", () => {
  it("maps the stored context and saves only validated mappings", async () => {
    const model = createScriptedModel([fixture.recordedOutput]);
    await createConceptMappingHandler({ db: handle.db, model, graph, log })({ runId }, job);

    const view = await getConceptMappingForUser(handle.db, userId, analysisId, versions);
    expect(view?.mappings.map((m) => m.conceptId)).toEqual(["web.idempotency", "web.retries"]);
    expect(view?.run).toMatchObject({
      status: "succeeded",
      provider: "scripted",
      model: "scripted-model",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(view?.run.dropped).toMatchObject({ unknown_concept: 1, unknown_path: 1 });
    expect(model.requests[0]!.prompt).toContain("src/billing/chargeCustomer.ts");
  });

  it("leaves a succeeded run alone", async () => {
    const model = createScriptedModel([fixture.recordedOutput]);
    const handler = createConceptMappingHandler({ db: handle.db, model, graph, log });
    await handler({ runId }, job);
    await handler({ runId }, { jobId: "job-2", attempt: 1 });
    expect(model.requests).toHaveLength(1);
  });

  it("marks the run failed and rethrows when a retry could help", async () => {
    const model = createScriptedModel([new ModelCallError("rate_limited")]);
    const handler = createConceptMappingHandler({ db: handle.db, model, graph, log });
    await expect(handler({ runId }, job)).rejects.toMatchObject({ code: "rate_limited" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "rate_limited" });
  });

  it("marks the run failed without retrying when a retry cannot help", async () => {
    const model = createScriptedModel([new ModelCallError("auth_failed")]);
    const handler = createConceptMappingHandler({ db: handle.db, model, graph, log });
    await expect(handler({ runId }, job)).resolves.toBeUndefined();
    expect(await run()).toMatchObject({ status: "failed", errorCode: "auth_failed" });
  });

  it("refuses a run created for another curriculum version", async () => {
    const model = createScriptedModel([fixture.recordedOutput]);
    const otherGraph = Object.create(graph, {
      version: { value: graph.version + 1 },
    }) as CurriculumGraph;
    await createConceptMappingHandler({ db: handle.db, model, graph: otherGraph, log })(
      { runId },
      job,
    );
    expect(await run()).toMatchObject({
      status: "failed",
      errorCode: "curriculum_version_mismatch",
    });
    expect(model.requests).toHaveLength(0);
  });

  it("fails a run whose stored context is not a valid analysis context", async () => {
    await handle.db
      .update(schema.prAnalyses)
      .set({ context: { files: "not a list" } })
      .where(eq(schema.prAnalyses.id, analysisId));
    const model = createScriptedModel([fixture.recordedOutput]);
    await createConceptMappingHandler({ db: handle.db, model, graph, log })({ runId }, job);
    expect(await run()).toMatchObject({ status: "failed", errorCode: "context_invalid" });
    expect(model.requests).toHaveLength(0);
  });
});
