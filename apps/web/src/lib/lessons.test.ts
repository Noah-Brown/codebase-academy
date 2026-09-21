import { validateLessonOutput } from "@academy/ai";
import { idempotencyLessonOutput } from "@academy/ai/testing";
import { MAPPER_VERSION } from "@academy/ai/versions";
import { getCurriculum } from "@academy/curriculum";
import {
  completeLessonGeneration,
  completeMappingRun,
  importCurriculum,
  initializeLearner,
  linkVerifiedUserInstallation,
  markAnalysisRunning,
  markAnalysisSucceeded,
  markLessonGenerating,
  markMappingRunRunning,
  recordAttemptGrade,
  requestAnalysis,
  scheduleConceptMapping,
  schema,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceLesson,
  attemptStatus,
  beginLesson,
  flagGrade,
  loadLessonSelection,
  loadLessonView,
  startLesson,
  submitStep,
} from "./lessons";

const { graph } = getCurriculum();
const concept = graph.require("web.idempotency");

let handle: DatabaseHandle;
let ownerId: string;
let strangerId: string;
let analysisId: string;
let unmappedAnalysisId: string;

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
  for (const userId of [ownerId, strangerId]) {
    await initializeLearner(handle.db, { userId, level: "intermediate", graph });
  }
  await upsertInstallation(handle.db, { id: 88, accountLogin: "acme", accountType: "User" });
  await linkVerifiedUserInstallation(handle.db, { userId: ownerId, installationId: 88 });
  await syncInstallationRepositories(handle.db, 88, [
    {
      id: 9100,
      owner: "acme",
      name: "billing",
      fullName: "acme/billing",
      defaultBranch: "main",
      private: true,
    },
  ]);

  const analyzed = async (number: number) => {
    const pr = await upsertPullRequest(handle.db, 9100, {
      number,
      title: "Retry failed charges",
      authorLogin: "dev",
      baseRef: "main",
      headRef: `feature-${number}`,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      state: "open",
      githubUpdatedAt: new Date("2026-09-15T00:00:00Z"),
    });
    const requested = await requestAnalysis(handle.db, {
      userId: ownerId,
      pullRequestId: pr.id,
      analyzerVersion: "context-v1",
    });
    if (requested.status !== "created") throw new Error("analysis not created");
    await markAnalysisRunning(handle.db, requested.analysis.id);
    await markAnalysisSucceeded(handle.db, requested.analysis.id, {
      context: {},
      estimatedTokens: 1,
    });
    return requested.analysis.id;
  };

  analysisId = await analyzed(1);
  unmappedAnalysisId = await analyzed(2);
  const run = await scheduleConceptMapping(handle.db, {
    analysisId,
    mapperVersion: MAPPER_VERSION,
    curriculumVersion: graph.version,
  });
  if (run.status !== "scheduled") throw new Error("mapping not scheduled");
  await markMappingRunRunning(handle.db, run.run.id);
  await completeMappingRun(handle.db, run.run.id, {
    mappings: [
      {
        conceptId: "web.idempotency",
        relevance: 0.85,
        significance: 0.9,
        suggestedDepth: "advanced",
        evidence: [
          {
            path: "src/billing/chargeCustomer.ts",
            startLine: 6,
            endLine: 8,
            excerpt: 'return await paymentsClient.post("/charges", payload);',
            rationale: "A POST that creates a charge is retried.",
          },
        ],
      },
    ],
    dropped: {},
    provider: "scripted",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

/** Stand in for the worker: store a lesson valid for the depth the server chose. */
async function generateFor(lessonId: string) {
  const [lesson] = await handle.db
    .select()
    .from(schema.lessons)
    .where(eq(schema.lessons.id, lessonId));
  const steps = idempotencyLessonOutput.steps.map((step) =>
    step.type === "open_response" ? { ...step, mode: "explain" as const } : step,
  );
  const content = validateLessonOutput(
    { ...idempotencyLessonOutput, steps },
    {
      concept,
      depth: lesson!.depth,
      evidence: (lesson!.sources as { evidence: never }).evidence,
    },
  );
  await markLessonGenerating(handle.db, lessonId);
  await completeLessonGeneration(handle.db, lessonId, {
    content,
    provider: "scripted",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });
}

describe("startLesson", () => {
  it("validates input and scope", async () => {
    expect(await startLesson(handle.db, ownerId, analysisId, { concept: "x" })).toMatchObject({
      status: 400,
    });
    expect(
      await startLesson(handle.db, strangerId, analysisId, { conceptId: "web.idempotency" }),
    ).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(
      await startLesson(handle.db, ownerId, unmappedAnalysisId, { conceptId: "web.idempotency" }),
    ).toEqual({ status: 409, body: { error: "not_mapped" } });
    expect(await startLesson(handle.db, ownerId, analysisId, { conceptId: "db.indexes" })).toEqual({
      status: 409,
      body: { error: "concept_not_ranked" },
    });
  });

  it("uses the server's ranking for depth and evidence, ignoring client hints", async () => {
    const { selection } = await loadLessonSelection(handle.db, ownerId, analysisId);
    const ranked = selection!.ranked.find((c) => c.conceptId === "web.idempotency")!;

    const first = await startLesson(handle.db, ownerId, analysisId, {
      conceptId: "web.idempotency",
      depth: "defense",
    });
    const again = await startLesson(handle.db, ownerId, analysisId, {
      conceptId: "web.idempotency",
    });
    expect(first.status).toBe(202);
    expect(again.body).toEqual(first.body);

    const lessonId = (first.body as { lessonId: string }).lessonId;
    const [row] = await handle.db
      .select()
      .from(schema.lessons)
      .where(eq(schema.lessons.id, lessonId));
    expect(row!.depth).toBe(ranked.depth);
    expect((row!.sources as { evidence: Array<{ id: string }> }).evidence.map((e) => e.id)).toEqual(
      ["e1"],
    );
  });
});

describe("taking a lesson", () => {
  it("walks one step at a time, grades checks, hides answers, and completes", async () => {
    const started = await startLesson(handle.db, ownerId, analysisId, {
      conceptId: "web.idempotency",
    });
    const lessonId = (started.body as { lessonId: string }).lessonId;

    expect(await loadLessonView(handle.db, ownerId, lessonId)).toMatchObject({ status: "queued" });
    expect(await loadLessonView(handle.db, strangerId, lessonId)).toBeNull();
    expect(await beginLesson(handle.db, ownerId, lessonId)).toEqual({
      status: 409,
      body: { error: "not_ready" },
    });

    await generateFor(lessonId);
    const ready = await loadLessonView(handle.db, ownerId, lessonId);
    expect(ready).toMatchObject({ status: "ready", session: null });
    const serialized = JSON.stringify(ready);
    expect(serialized).not.toContain("correctChoiceId");
    expect(serialized).not.toContain("exemplarSummary");
    expect(serialized).not.toContain("rubric");

    const begun = await beginLesson(handle.db, ownerId, lessonId);
    expect(begun).toMatchObject({ status: 200, body: { currentStep: 0 } });
    const sessionId = (begun.body as { sessionId: string }).sessionId;
    expect(await beginLesson(handle.db, ownerId, lessonId)).toEqual(begun);

    expect(await submitStep(handle.db, ownerId, sessionId, 0, { dontKnow: true })).toEqual({
      status: 409,
      body: { error: "not_an_assessment" },
    });
    expect(await submitStep(handle.db, ownerId, sessionId, 2, { choiceId: "a" })).toEqual({
      status: 409,
      body: { error: "not_current_step" },
    });
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 0 })).toMatchObject({
      status: 200,
    });
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 1 })).toMatchObject({
      status: 200,
    });

    // Multiple choice: answer first, graded deterministically, answer key revealed after.
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 2 })).toEqual({
      status: 409,
      body: { error: "answer_first" },
    });
    expect(await submitStep(handle.db, ownerId, sessionId, 2, { choiceId: "zz" })).toMatchObject({
      status: 400,
    });
    const wrong = await submitStep(handle.db, ownerId, sessionId, 2, { choiceId: "b" });
    expect(wrong).toMatchObject({
      status: 200,
      body: {
        attempt: {
          status: "graded",
          correct: false,
          score: 0,
          reveal: { type: "multiple_choice", correctChoiceId: "a" },
          mastery: { applied: true },
        },
      },
    });
    const resubmitted = await submitStep(handle.db, ownerId, sessionId, 2, { choiceId: "a" });
    expect(
      (resubmitted.body as { attempt: { id: string; correct: boolean } }).attempt,
    ).toMatchObject({
      id: (wrong.body as { attempt: { id: string } }).attempt.id,
      correct: false,
    });
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 2 })).toMatchObject({
      status: 200,
    });

    // Open response: queued for the grader; no reveal until graded.
    expect(await submitStep(handle.db, ownerId, sessionId, 3, { text: "   " })).toMatchObject({
      status: 400,
    });
    const written = await submitStep(handle.db, ownerId, sessionId, 3, {
      text: "Send an idempotency key with every attempt.",
    });
    const writtenAttempt = (written.body as { attempt: { id: string } }).attempt;
    expect(written).toMatchObject({
      status: 200,
      body: { attempt: { status: "grading", reveal: null } },
    });
    const gradingJobs = await handle.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.queue, "assessment-grading"));
    expect(gradingJobs).toHaveLength(1);
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 3 })).toEqual({
      status: 409,
      body: { error: "answer_first" },
    });
    expect(await flagGrade(handle.db, ownerId, writtenAttempt.id, {})).toMatchObject({
      status: 404,
    });

    await recordAttemptGrade(handle.db, {
      attemptId: writtenAttempt.id,
      userId: ownerId,
      sessionId,
      conceptId: "web.idempotency",
      curriculumVersion: graph.version,
      score: 0.75,
      graderConfidence: 0.9,
      grading: {
        feedback: "Good start.",
        criterionResults: [
          { criterion: "Key", met: "yes", evidenceFromAnswer: "idempotency key", verified: true },
        ],
      },
      graderProvider: "scripted",
      graderModel: "m",
      graderVersion: "grader-v1",
    });
    expect(await attemptStatus(handle.db, ownerId, writtenAttempt.id)).toMatchObject({
      status: 200,
      body: {
        attempt: { status: "graded", feedback: "Good start.", reveal: { type: "open_response" } },
      },
    });
    expect(await attemptStatus(handle.db, strangerId, writtenAttempt.id)).toMatchObject({
      status: 404,
    });
    expect(
      await flagGrade(handle.db, ownerId, writtenAttempt.id, { note: "Too generous" }),
    ).toEqual({
      status: 200,
      body: { flagged: true },
    });

    // Reaching the takeaway completes the lesson and feeds the recent-lesson penalty.
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 3 })).toEqual({
      status: 200,
      body: { currentStep: 4, status: "completed" },
    });
    expect(await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 4 })).toMatchObject({
      status: 409,
    });
    const done = await loadLessonView(handle.db, ownerId, lessonId);
    expect(done).toMatchObject({ status: "ready", session: { status: "completed" } });
    if (done?.status === "ready") {
      expect(done.attempts).toHaveLength(2);
      expect(done.attempts.every((a) => a.mastery?.applied)).toBe(true);
    }

    const { selection } = await loadLessonSelection(handle.db, ownerId, analysisId);
    const penalties = selection!.ranked.find((c) => c.conceptId === "web.idempotency")!.breakdown
      .penalties;
    expect(penalties.map((p) => p.code)).toContain("recent_lesson");
  });

  it("records 'I don't know' as a graded zero without shame or a model call", async () => {
    const { selection } = await loadLessonSelection(handle.db, ownerId, analysisId);
    expect(selection).not.toBeNull();
    const started = await startLesson(handle.db, ownerId, analysisId, {
      conceptId: "web.idempotency",
    });
    const lessonId = (started.body as { lessonId: string }).lessonId;
    if ((await loadLessonView(handle.db, ownerId, lessonId))?.status !== "ready") {
      await generateFor(lessonId);
    }
    const begun = await beginLesson(handle.db, ownerId, lessonId);
    const sessionId = (begun.body as { sessionId: string }).sessionId;
    await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 0 });
    await advanceLesson(handle.db, ownerId, sessionId, { fromStep: 1 });
    const result = await submitStep(handle.db, ownerId, sessionId, 2, { dontKnow: true });
    expect(result).toMatchObject({
      status: 200,
      body: {
        attempt: {
          responseKind: "dont_know",
          status: "graded",
          score: 0,
          reveal: { type: "multiple_choice" },
        },
      },
    });
  });
});
