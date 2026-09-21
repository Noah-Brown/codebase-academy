import { getCurriculum } from "@academy/curriculum";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./client";
import {
  completeMappingRun,
  markMappingRunRunning,
  scheduleConceptMapping,
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
import {
  getLearnerStates,
  initializeLearner,
  recordAssessmentEvidence,
} from "./learner-repository";
import {
  LESSON_GENERATION_QUEUE,
  advanceSession,
  completeLessonGeneration,
  createAttempt,
  flagAttempt,
  getLessonForUser,
  getMasteryEventsForAttempts,
  listRecentLessonCompletions,
  markLessonFailed,
  markLessonGenerating,
  recordAttemptGrade,
  requestLesson,
  startLessonSession,
} from "./lesson-repository";
import { assessmentAttempts, jobs, lessonSessions, masteryEvents, users } from "./schema";
import { createTestDatabase } from "./testing";

const { graph } = getCurriculum();
let handle: DatabaseHandle;
let nextId = 50_000;

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
  await initializeLearner(handle.db, { userId: user!.id, level: "intermediate", graph });
  return user!.id;
}

/** A learner with an analyzed, mapped pull request. */
async function seed() {
  const userId = await createUser();
  const installationId = nextId++;
  const repositoryId = nextId++;
  await upsertInstallation(handle.db, {
    id: installationId,
    accountLogin: "acme",
    accountType: "User",
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
    number: 3,
    title: "Retry charges",
    authorLogin: "dev",
    baseRef: "main",
    headRef: "retry",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    state: "open",
    githubUpdatedAt: new Date("2026-09-15T00:00:00Z"),
  });
  const requested = await requestAnalysis(handle.db, {
    userId,
    pullRequestId: pr.id,
    analyzerVersion: "context-v1",
  });
  if (requested.status !== "created") throw new Error("analysis not created");
  const analysisId = requested.analysis.id;
  await markAnalysisRunning(handle.db, analysisId);
  await markAnalysisSucceeded(handle.db, analysisId, { context: {}, estimatedTokens: 1 });
  const scheduled = await scheduleConceptMapping(handle.db, {
    analysisId,
    mapperVersion: "mapper-test",
    curriculumVersion: graph.version,
  });
  if (scheduled.status !== "scheduled") throw new Error("mapping not scheduled");
  await markMappingRunRunning(handle.db, scheduled.run.id);
  await completeMappingRun(handle.db, scheduled.run.id, {
    mappings: [
      {
        conceptId: "web.idempotency",
        relevance: 0.85,
        significance: 0.9,
        suggestedDepth: "advanced",
        evidence: [
          { path: "src/charge.ts", excerpt: "retry(charge)", rationale: "Retries a charge." },
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
  return { userId, installationId, analysisId, mappingRunId: scheduled.run.id };
}

const lessonRequest = (seeded: Awaited<ReturnType<typeof seed>>) => ({
  userId: seeded.userId,
  analysisId: seeded.analysisId,
  mappingRunId: seeded.mappingRunId,
  conceptId: "web.idempotency",
  curriculumVersion: graph.version,
  depth: "advanced" as const,
  generatorVersion: "lesson-test",
  sources: { reasons: ["test"] },
});

async function readyLesson(seeded: Awaited<ReturnType<typeof seed>>) {
  const requested = await requestLesson(handle.db, lessonRequest(seeded));
  if (requested.status === "not_found") throw new Error("lesson not requested");
  await markLessonGenerating(handle.db, requested.lesson.id);
  await completeLessonGeneration(handle.db, requested.lesson.id, {
    content: { steps: [] },
    provider: "scripted",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });
  return requested.lesson.id;
}

const generationJobs = async (lessonId: string) =>
  (await handle.db.select().from(jobs).where(eq(jobs.queue, LESSON_GENERATION_QUEUE))).filter(
    (job) => (job.payload as { lessonId: string }).lessonId === lessonId,
  );

describe("requestLesson", () => {
  it("creates one lesson and one generation job per learner, pull request, concept, and depth", async () => {
    const seeded = await seed();
    const first = await requestLesson(handle.db, lessonRequest(seeded));
    const again = await requestLesson(handle.db, lessonRequest(seeded));
    expect(first.status).toBe("scheduled");
    expect(again.status).toBe("existing");
    if (first.status === "not_found" || again.status === "not_found") return;
    expect(again.lesson.id).toBe(first.lesson.id);
    expect(await generationJobs(first.lesson.id)).toHaveLength(1);

    const deeper = await requestLesson(handle.db, { ...lessonRequest(seeded), depth: "defense" });
    expect(deeper.status).toBe("scheduled");
  });

  it("retries a failed lesson once per failure", async () => {
    const seeded = await seed();
    const first = await requestLesson(handle.db, lessonRequest(seeded));
    if (first.status === "not_found") throw new Error("not requested");
    await markLessonGenerating(handle.db, first.lesson.id);
    await markLessonFailed(handle.db, first.lesson.id, "rate_limited");
    expect((await requestLesson(handle.db, lessonRequest(seeded))).status).toBe("scheduled");
    expect((await requestLesson(handle.db, lessonRequest(seeded))).status).toBe("existing");
    expect(await generationJobs(first.lesson.id)).toHaveLength(2);
  });

  it("refuses analyses the learner cannot see, and hides lessons from other users", async () => {
    const seeded = await seed();
    const stranger = await createUser();
    expect(await requestLesson(handle.db, { ...lessonRequest(seeded), userId: stranger })).toEqual({
      status: "not_found",
    });

    const lessonId = await readyLesson(seeded);
    expect(await getLessonForUser(handle.db, stranger, lessonId)).toBeNull();
    expect((await getLessonForUser(handle.db, seeded.userId, lessonId))?.lesson.status).toBe(
      "ready",
    );
    await markInstallationDeleted(handle.db, seeded.installationId);
    expect(await getLessonForUser(handle.db, seeded.userId, lessonId)).toBeNull();
  });
});

describe("sessions and attempts", () => {
  it("starts a ready lesson once and resumes the active session", async () => {
    const seeded = await seed();
    const pending = await requestLesson(handle.db, lessonRequest(seeded));
    if (pending.status === "not_found") throw new Error("not requested");
    expect(
      await startLessonSession(handle.db, { userId: seeded.userId, lessonId: pending.lesson.id }),
    ).toEqual({
      status: "not_ready",
    });

    const lessonId = await readyLesson({ ...seeded });
    const started = await startLessonSession(handle.db, { userId: seeded.userId, lessonId });
    const resumed = await startLessonSession(handle.db, { userId: seeded.userId, lessonId });
    expect(started.status).toBe("started");
    expect(resumed.status).toBe("resumed");
    if (started.status !== "started" || resumed.status !== "resumed") return;
    expect(resumed.session.id).toBe(started.session.id);
  });

  it("records one attempt per step and exactly one mastery event per attempt", async () => {
    const seeded = await seed();
    const lessonId = await readyLesson(seeded);
    const started = await startLessonSession(handle.db, { userId: seeded.userId, lessonId });
    if (started.status !== "started") throw new Error("not started");
    const attemptInput = {
      userId: seeded.userId,
      sessionId: started.session.id,
      stepIndex: 2,
      responseKind: "choice" as const,
      response: { choiceId: "a" },
      evidenceKind: "prediction" as const,
      assessmentMode: "predict" as const,
    };
    const created = await createAttempt(handle.db, attemptInput);
    const duplicate = await createAttempt(handle.db, {
      ...attemptInput,
      response: { choiceId: "b" },
    });
    expect(created.status).toBe("created");
    expect(duplicate).toMatchObject({ status: "exists", attempt: { id: created.attempt.id } });

    const grade = {
      attemptId: created.attempt.id,
      userId: seeded.userId,
      sessionId: started.session.id,
      conceptId: "web.idempotency",
      curriculumVersion: graph.version,
      score: 1,
      graderConfidence: 1,
      grading: { correct: true },
      graderProvider: null,
      graderModel: null,
      graderVersion: "deterministic",
    };
    const first = await recordAttemptGrade(handle.db, grade);
    const second = await recordAttemptGrade(handle.db, grade);
    expect(first.attempt).toMatchObject({
      status: "graded",
      score: 1,
      masteryEventId: first.event.id,
    });
    expect(second.event.id).toBe(first.event.id);
    expect(
      await getMasteryEventsForAttempts(handle.db, seeded.userId, [created.attempt.id]),
    ).toHaveLength(1);

    const state = (await getLearnerStates(handle.db, seeded.userId)).find(
      (s) => s.conceptId === "web.idempotency",
    );
    expect(state?.evidenceCount).toBe(1);

    await expect(
      recordAssessmentEvidence(handle.db, {
        userId: seeded.userId,
        curriculumVersion: graph.version,
        assessmentAttemptId: created.attempt.id,
        evidence: {
          conceptId: "web.idempotency",
          kind: "prediction",
          mode: "predict",
          score: 1,
          graderConfidence: 1,
          sessionId: started.session.id,
          occurredAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    const events = await handle.db
      .select()
      .from(masteryEvents)
      .where(eq(masteryEvents.assessmentAttemptId, created.attempt.id));
    expect(events).toHaveLength(1);
  });

  it("advances one step at a time and records completion for the ranker", async () => {
    const seeded = await seed();
    const lessonId = await readyLesson(seeded);
    const started = await startLessonSession(handle.db, { userId: seeded.userId, lessonId });
    if (started.status !== "started") throw new Error("not started");
    const sessionId = started.session.id;

    expect(
      await advanceSession(handle.db, sessionId, { fromStep: 0, complete: false }),
    ).toMatchObject({
      currentStep: 1,
    });
    expect(await advanceSession(handle.db, sessionId, { fromStep: 0, complete: false })).toBeNull();
    const done = await advanceSession(handle.db, sessionId, { fromStep: 1, complete: true });
    expect(done).toMatchObject({ status: "completed", currentStep: 2 });
    expect(done?.completedAt).toBeInstanceOf(Date);
    expect(await advanceSession(handle.db, sessionId, { fromStep: 2, complete: false })).toBeNull();

    const recent = await listRecentLessonCompletions(
      handle.db,
      seeded.userId,
      new Date(Date.now() - 60_000),
    );
    expect(recent.map((r) => r.conceptId)).toEqual(["web.idempotency"]);
    const [row] = await handle.db
      .select()
      .from(lessonSessions)
      .where(eq(lessonSessions.id, sessionId));
    expect(row?.status).toBe("completed");
  });

  it("lets only the owner flag a graded attempt", async () => {
    const seeded = await seed();
    const lessonId = await readyLesson(seeded);
    const started = await startLessonSession(handle.db, { userId: seeded.userId, lessonId });
    if (started.status !== "started") throw new Error("not started");
    const { attempt } = await createAttempt(handle.db, {
      userId: seeded.userId,
      sessionId: started.session.id,
      stepIndex: 3,
      responseKind: "text",
      response: { text: "Use an idempotency key." },
      evidenceKind: "design_comparison",
      assessmentMode: "compare",
    });
    const flag = (userId: string) =>
      flagAttempt(handle.db, { userId, attemptId: attempt.id, note: "Too harsh" });

    expect(await flag(seeded.userId)).toBe(false);
    await recordAttemptGrade(handle.db, {
      attemptId: attempt.id,
      userId: seeded.userId,
      sessionId: started.session.id,
      conceptId: "web.idempotency",
      curriculumVersion: graph.version,
      score: 0.5,
      graderConfidence: 0.8,
      grading: { feedback: "Partly there." },
      graderProvider: "scripted",
      graderModel: "m",
      graderVersion: "grader-test",
    });
    expect(await flag(await createUser())).toBe(false);
    expect(await flag(seeded.userId)).toBe(true);
    const [row] = await handle.db
      .select()
      .from(assessmentAttempts)
      .where(eq(assessmentAttempts.id, attempt.id));
    expect(row).toMatchObject({ flagNote: "Too harsh", score: 0.5 });
    expect(row?.flaggedAt).toBeInstanceOf(Date);
  });
});
