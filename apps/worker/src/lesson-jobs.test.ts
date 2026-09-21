import {
  createScriptedModel,
  goldenFixtures,
  idempotencyGraderOutput,
  idempotencyLessonOutput,
  idempotencySources,
  ModelCallError,
  strongIdempotencyAnswer,
} from "@academy/ai/testing";
import { getCurriculum, type CurriculumGraph } from "@academy/curriculum";
import {
  completeMappingRun,
  createAttempt,
  getMasteryEventsForAttempts,
  importCurriculum,
  initializeLearner,
  linkVerifiedUserInstallation,
  markAnalysisRunning,
  markAnalysisSucceeded,
  markMappingRunRunning,
  requestAnalysis,
  requestLesson,
  scheduleConceptMapping,
  schema,
  startLessonSession,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import { createLogger } from "@academy/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAssessmentGradingHandler } from "./assessment-grading";
import { createLessonGenerationHandler } from "./lesson-generation";

const { graph } = getCurriculum();
const log = createLogger({ write: () => {} });
const job = { jobId: "job-1", attempt: 1 };
const fixture = goldenFixtures.find((f) => f.id === "retry-idempotency")!;

let handle: DatabaseHandle;
let userId: string;
let lessonId: string;

beforeEach(async () => {
  await handle?.close();
  handle = await createTestDatabase();
  await importCurriculum(handle.db, graph.curriculum);
  const [user] = await handle.db
    .insert(schema.users)
    .values({ name: "Dev", email: "dev@example.test" })
    .returning();
  userId = user!.id;
  await initializeLearner(handle.db, { userId, level: "intermediate", graph });
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
    title: "Retry failed charges",
    authorLogin: "example-dev",
    baseRef: "main",
    headRef: "feature",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "open",
    githubUpdatedAt: new Date("2026-09-15T09:00:00Z"),
  });
  const analysis = await requestAnalysis(handle.db, {
    userId,
    pullRequestId: pr.id,
    analyzerVersion: fixture.context.analyzerVersion,
  });
  if (analysis.status !== "created") throw new Error("analysis not created");
  await markAnalysisRunning(handle.db, analysis.analysis.id);
  await markAnalysisSucceeded(handle.db, analysis.analysis.id, {
    context: fixture.context,
    estimatedTokens: 1,
  });
  const run = await scheduleConceptMapping(handle.db, {
    analysisId: analysis.analysis.id,
    mapperVersion: "mapper-v1",
    curriculumVersion: graph.version,
  });
  if (run.status !== "scheduled") throw new Error("mapping not scheduled");
  await markMappingRunRunning(handle.db, run.run.id);
  await completeMappingRun(handle.db, run.run.id, {
    mappings: [],
    dropped: {},
    provider: "scripted",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });
  const lesson = await requestLesson(handle.db, {
    userId,
    analysisId: analysis.analysis.id,
    mappingRunId: run.run.id,
    conceptId: "web.idempotency",
    curriculumVersion: graph.version,
    depth: "advanced",
    generatorVersion: "lesson-v1",
    sources: idempotencySources,
  });
  if (lesson.status === "not_found") throw new Error("lesson not requested");
  lessonId = lesson.lesson.id;
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function lessonRow() {
  const [row] = await handle.db
    .select()
    .from(schema.lessons)
    .where(eq(schema.lessons.id, lessonId));
  return row!;
}

async function generate(model = createScriptedModel([idempotencyLessonOutput])) {
  await createLessonGenerationHandler({ db: handle.db, model, graph, log })({ lessonId }, job);
  return model;
}

describe("lesson generation job", () => {
  it("stores a validated lesson built from the snapshotted sources", async () => {
    const model = await generate();
    const row = await lessonRow();
    expect(row).toMatchObject({ status: "ready", provider: "scripted", model: "scripted-model" });
    const content = row.content as { depth: string; steps: unknown[]; evidence: unknown[] };
    expect(content.depth).toBe("advanced");
    expect(content.steps).toHaveLength(5);
    expect(content.evidence).toEqual(idempotencySources.evidence);
    expect(model.requests[0]!.prompt).toContain("src/billing/chargeCustomer.ts");

    const again = await generate();
    expect(again.requests).toHaveLength(0);
  });

  it("fails and rethrows when the lesson structure is invalid, so the queue retries", async () => {
    const broken = { ...idempotencyLessonOutput, steps: idempotencyLessonOutput.steps.slice(0, 2) };
    const model = createScriptedModel([broken]);
    const handler = createLessonGenerationHandler({ db: handle.db, model, graph, log });
    await expect(handler({ lessonId }, job)).rejects.toMatchObject({ code: "invalid_output" });
    expect(await lessonRow()).toMatchObject({ status: "failed", errorCode: "invalid_output" });
  });

  it("refuses a lesson requested under another curriculum version", async () => {
    const model = createScriptedModel([idempotencyLessonOutput]);
    const otherGraph = Object.create(graph, {
      version: { value: graph.version + 1 },
    }) as CurriculumGraph;
    await createLessonGenerationHandler({ db: handle.db, model, graph: otherGraph, log })(
      { lessonId },
      job,
    );
    expect(await lessonRow()).toMatchObject({
      status: "failed",
      errorCode: "curriculum_version_mismatch",
    });
    expect(model.requests).toHaveLength(0);
  });
});

describe("assessment grading job", () => {
  async function textAttempt() {
    await generate();
    const session = await startLessonSession(handle.db, { userId, lessonId });
    if (session.status !== "started") throw new Error("session not started");
    const { attempt } = await createAttempt(handle.db, {
      userId,
      sessionId: session.session.id,
      stepIndex: 3,
      responseKind: "text",
      response: { text: strongIdempotencyAnswer },
      evidenceKind: "design_comparison",
      assessmentMode: "compare",
    });
    return attempt;
  }

  const attemptRow = async (id: string) => {
    const [row] = await handle.db
      .select()
      .from(schema.assessmentAttempts)
      .where(eq(schema.assessmentAttempts.id, id));
    return row!;
  };

  it("grades against the stored rubric and records one mastery event", async () => {
    const attempt = await textAttempt();
    const model = createScriptedModel([idempotencyGraderOutput], { model: "grader-model" });
    const handler = createAssessmentGradingHandler({ db: handle.db, model, graph, log });
    await handler({ attemptId: attempt.id }, job);

    const row = await attemptRow(attempt.id);
    expect(row).toMatchObject({
      status: "graded",
      graderModel: "grader-model",
      graderVersion: "grader-v1",
    });
    expect(row.score).toBeCloseTo(0.8333, 3);
    expect(row.graderConfidence).toBe(0.9);
    expect((row.grading as { feedback: string }).feedback).toContain("idempotency key");
    expect(model.requests[0]!.prompt).toContain(strongIdempotencyAnswer);

    const events = await getMasteryEventsForAttempts(handle.db, userId, [attempt.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ evidenceKind: "design_comparison", applied: true });
    expect(row.masteryEventId).toBe(events[0]!.id);

    await handler({ attemptId: attempt.id }, job);
    expect(model.requests).toHaveLength(1);
    expect(await getMasteryEventsForAttempts(handle.db, userId, [attempt.id])).toHaveLength(1);
  });

  it("marks the attempt failed without retrying when the provider rejects credentials", async () => {
    const attempt = await textAttempt();
    const model = createScriptedModel([new ModelCallError("auth_failed")]);
    const handler = createAssessmentGradingHandler({ db: handle.db, model, graph, log });
    await expect(handler({ attemptId: attempt.id }, job)).resolves.toBeUndefined();
    expect(await attemptRow(attempt.id)).toMatchObject({
      status: "failed",
      errorCode: "auth_failed",
    });
    expect(await getMasteryEventsForAttempts(handle.db, userId, [attempt.id])).toHaveLength(0);
  });
});
