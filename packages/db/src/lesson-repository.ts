import type { AssessmentMode } from "@academy/curriculum";
import type { EvidenceKind, LessonDepth } from "@academy/learning";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "./client";
import { getAnalysisForUser, getAnalysisForWorker, type AnalysisAccess } from "./github-repository";
import { enqueueJob } from "./job-queue";
import { recordAssessmentEvidence, type MasteryEventRow } from "./learner-repository";
import {
  assessmentAttempts,
  lessonSessions,
  lessons,
  masteryEvents,
  type ResponseKind,
} from "./schema";

export const LESSON_GENERATION_QUEUE = "lesson-generation";
export const ASSESSMENT_GRADING_QUEUE = "assessment-grading";

export type LessonRow = typeof lessons.$inferSelect;
export type LessonSessionRow = typeof lessonSessions.$inferSelect;
export type AssessmentAttemptRow = typeof assessmentAttempts.$inferSelect;

export interface LessonGenerationJobPayload {
  lessonId: string;
}
export interface AssessmentGradingJobPayload {
  attemptId: string;
}

export interface LessonAccess extends AnalysisAccess {
  lesson: LessonRow;
}
export interface SessionAccess extends LessonAccess {
  session: LessonSessionRow;
}
export interface AttemptAccess extends SessionAccess {
  attempt: AssessmentAttemptRow;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID_PATTERN.test(value);

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export interface LessonRequest {
  userId: string;
  analysisId: string;
  mappingRunId: string;
  conceptId: string;
  curriculumVersion: number;
  /** Computed server-side by the ranker; never taken from the client. */
  depth: LessonDepth;
  generatorVersion: string;
  sources: Record<string, unknown>;
}

export type RequestLessonResult =
  { status: "scheduled" | "existing"; lesson: LessonRow } | { status: "not_found" };

/**
 * Create (or return) the lesson for this learner, pull request, concept, and depth, and make sure a
 * job will generate it. A failed lesson is reset and retried at most once per failure.
 */
export async function requestLesson(
  db: Database,
  input: LessonRequest,
): Promise<RequestLessonResult> {
  const access = await getAnalysisForUser(db, input.userId, input.analysisId);
  if (!access) return { status: "not_found" };

  const [created] = await db
    .insert(lessons)
    .values(input)
    .onConflictDoNothing({
      target: [
        lessons.userId,
        lessons.analysisId,
        lessons.conceptId,
        lessons.depth,
        lessons.generatorVersion,
      ],
    })
    .returning();
  if (created) {
    const payload: LessonGenerationJobPayload = { lessonId: created.id };
    await enqueueJob(db, {
      queue: LESSON_GENERATION_QUEUE,
      payload,
      idempotencyKey: `lesson-generation:${created.id}`,
    });
    return { status: "scheduled", lesson: created };
  }

  const [existing] = await db
    .select()
    .from(lessons)
    .where(
      and(
        eq(lessons.userId, input.userId),
        eq(lessons.analysisId, input.analysisId),
        eq(lessons.conceptId, input.conceptId),
        eq(lessons.depth, input.depth),
        eq(lessons.generatorVersion, input.generatorVersion),
      ),
    );
  if (!existing) return { status: "not_found" };
  if (existing.status !== "failed") return { status: "existing", lesson: existing };

  const [reset] = await db
    .update(lessons)
    .set({ status: "queued", errorCode: null, updatedAt: new Date() })
    .where(and(eq(lessons.id, existing.id), eq(lessons.status, "failed")))
    .returning();
  if (!reset) return { status: "existing", lesson: existing };
  const payload: LessonGenerationJobPayload = { lessonId: reset.id };
  await enqueueJob(db, {
    queue: LESSON_GENERATION_QUEUE,
    payload,
    idempotencyKey: `lesson-generation:${reset.id}:retry:${existing.updatedAt.getTime()}`,
  });
  return { status: "scheduled", lesson: reset };
}

/** A lesson the user owns and whose repository they can still access; otherwise null. */
export async function getLessonForUser(
  db: Database,
  userId: string,
  lessonId: string,
): Promise<LessonAccess | null> {
  if (!isUuid(lessonId)) return null;
  const [lesson] = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.id, lessonId), eq(lessons.userId, userId)));
  if (!lesson) return null;
  const access = await getAnalysisForUser(db, userId, lesson.analysisId);
  return access ? { ...access, lesson } : null;
}

export async function getLessonForWorker(
  db: Database,
  lessonId: string,
): Promise<LessonAccess | null> {
  if (!isUuid(lessonId)) return null;
  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId));
  if (!lesson) return null;
  const access = await getAnalysisForWorker(db, lesson.analysisId);
  return access ? { ...access, lesson } : null;
}

/** Claims a lesson for generation. A generating lesson may be reclaimed after a worker crash. */
export async function markLessonGenerating(db: Database, lessonId: string): Promise<boolean> {
  const rows = await db
    .update(lessons)
    .set({ status: "generating", errorCode: null, updatedAt: new Date() })
    .where(
      and(eq(lessons.id, lessonId), inArray(lessons.status, ["queued", "generating", "failed"])),
    )
    .returning({ id: lessons.id });
  return rows.length > 0;
}

export async function completeLessonGeneration(
  db: Database,
  lessonId: string,
  result: {
    content: Record<string, unknown>;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  },
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(lessons)
    .set({ ...result, status: "ready", errorCode: null, readyAt: now, updatedAt: now })
    .where(and(eq(lessons.id, lessonId), eq(lessons.status, "generating")))
    .returning({ id: lessons.id });
  return rows.length > 0;
}

/** `errorCode` must be a stable machine code, never a message. */
export async function markLessonFailed(
  db: Database,
  lessonId: string,
  errorCode: string,
): Promise<boolean> {
  const rows = await db
    .update(lessons)
    .set({ status: "failed", errorCode, updatedAt: new Date() })
    .where(and(eq(lessons.id, lessonId), inArray(lessons.status, ["queued", "generating"])))
    .returning({ id: lessons.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type StartSessionResult =
  | { status: "started" | "resumed"; session: LessonSessionRow; access: LessonAccess }
  | { status: "not_found" | "not_ready" };

async function activeSession(db: Database, lessonId: string, userId: string) {
  const [session] = await db
    .select()
    .from(lessonSessions)
    .where(
      and(
        eq(lessonSessions.lessonId, lessonId),
        eq(lessonSessions.userId, userId),
        eq(lessonSessions.status, "active"),
      ),
    );
  return session ?? null;
}

/** Begin a ready lesson, or resume its active session. At most one active session per lesson. */
export async function startLessonSession(
  db: Database,
  input: { userId: string; lessonId: string },
): Promise<StartSessionResult> {
  const access = await getLessonForUser(db, input.userId, input.lessonId);
  if (!access) return { status: "not_found" };
  if (access.lesson.status !== "ready") return { status: "not_ready" };

  const existing = await activeSession(db, input.lessonId, input.userId);
  if (existing) return { status: "resumed", session: existing, access };
  const [created] = await db
    .insert(lessonSessions)
    .values({ lessonId: input.lessonId, userId: input.userId })
    .onConflictDoNothing()
    .returning();
  if (created) return { status: "started", session: created, access };
  const raced = await activeSession(db, input.lessonId, input.userId);
  return raced ? { status: "resumed", session: raced, access } : { status: "not_found" };
}

export async function getSessionForUser(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<SessionAccess | null> {
  if (!isUuid(sessionId)) return null;
  const [session] = await db
    .select()
    .from(lessonSessions)
    .where(and(eq(lessonSessions.id, sessionId), eq(lessonSessions.userId, userId)));
  if (!session) return null;
  const access = await getLessonForUser(db, userId, session.lessonId);
  return access ? { ...access, session } : null;
}

/** The most recent session for a lesson (active first, then the latest completed). */
export async function getLatestSessionForLesson(
  db: Database,
  userId: string,
  lessonId: string,
): Promise<LessonSessionRow | null> {
  const [session] = await db
    .select()
    .from(lessonSessions)
    .where(and(eq(lessonSessions.lessonId, lessonId), eq(lessonSessions.userId, userId)))
    .orderBy(asc(lessonSessions.status), desc(lessonSessions.startedAt))
    .limit(1);
  return session ?? null;
}

/**
 * Move the session from `fromStep` to `fromStep + 1`, completing it when that is the last step.
 * Returns false when the session already moved (a double click) or is completed.
 */
export async function advanceSession(
  db: Database,
  sessionId: string,
  input: { fromStep: number; complete: boolean },
): Promise<LessonSessionRow | null> {
  const now = new Date();
  const [session] = await db
    .update(lessonSessions)
    .set({
      currentStep: input.fromStep + 1,
      updatedAt: now,
      ...(input.complete ? { status: "completed" as const, completedAt: now } : {}),
    })
    .where(
      and(
        eq(lessonSessions.id, sessionId),
        eq(lessonSessions.status, "active"),
        eq(lessonSessions.currentStep, input.fromStep),
      ),
    )
    .returning();
  return session ?? null;
}

/** Concepts the user finished a lesson on since `since`, for the ranker's recent-lesson penalty. */
export async function listRecentLessonCompletions(
  db: Database,
  userId: string,
  since: Date,
): Promise<Array<{ conceptId: string; completedAt: Date }>> {
  const rows = await db
    .select({ conceptId: lessons.conceptId, completedAt: lessonSessions.completedAt })
    .from(lessonSessions)
    .innerJoin(lessons, eq(lessons.id, lessonSessions.lessonId))
    .where(
      and(
        eq(lessonSessions.userId, userId),
        eq(lessonSessions.status, "completed"),
        isNotNull(lessonSessions.completedAt),
        gte(lessonSessions.completedAt, since),
      ),
    );
  return rows.map((row) => ({ conceptId: row.conceptId, completedAt: row.completedAt! }));
}

// ---------------------------------------------------------------------------
// Assessment attempts
// ---------------------------------------------------------------------------

export async function listAttempts(
  db: Database,
  sessionId: string,
): Promise<AssessmentAttemptRow[]> {
  return db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.sessionId, sessionId))
    .orderBy(asc(assessmentAttempts.stepIndex));
}

export type CreateAttemptResult =
  | { status: "created"; attempt: AssessmentAttemptRow }
  | { status: "exists"; attempt: AssessmentAttemptRow };

/** Record the learner's one answer to a step. A second submission returns the first attempt. */
export async function createAttempt(
  db: Database,
  input: {
    userId: string;
    sessionId: string;
    stepIndex: number;
    responseKind: ResponseKind;
    response: Record<string, unknown>;
    evidenceKind: EvidenceKind;
    assessmentMode: AssessmentMode;
  },
): Promise<CreateAttemptResult> {
  const [created] = await db
    .insert(assessmentAttempts)
    .values({ ...input, status: "grading" })
    .onConflictDoNothing({ target: [assessmentAttempts.sessionId, assessmentAttempts.stepIndex] })
    .returning();
  if (created) return { status: "created", attempt: created };
  const [existing] = await db
    .select()
    .from(assessmentAttempts)
    .where(
      and(
        eq(assessmentAttempts.sessionId, input.sessionId),
        eq(assessmentAttempts.stepIndex, input.stepIndex),
      ),
    );
  if (!existing) throw new Error("Attempt conflict without an existing attempt");
  return { status: "exists", attempt: existing };
}

async function attemptAccess(
  db: Database,
  attempt: AssessmentAttemptRow | undefined,
  load: (sessionId: string) => Promise<SessionAccess | null>,
): Promise<AttemptAccess | null> {
  if (!attempt) return null;
  const access = await load(attempt.sessionId);
  return access ? { ...access, attempt } : null;
}

export async function getAttemptForUser(
  db: Database,
  userId: string,
  attemptId: string,
): Promise<AttemptAccess | null> {
  if (!isUuid(attemptId)) return null;
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.userId, userId)));
  return attemptAccess(db, attempt, (sessionId) => getSessionForUser(db, userId, sessionId));
}

export async function getAttemptForWorker(
  db: Database,
  attemptId: string,
): Promise<AttemptAccess | null> {
  if (!isUuid(attemptId)) return null;
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.id, attemptId));
  return attemptAccess(db, attempt, async (sessionId) => {
    const [session] = await db
      .select()
      .from(lessonSessions)
      .where(eq(lessonSessions.id, sessionId));
    if (!session) return null;
    const lessonAccess = await getLessonForWorker(db, session.lessonId);
    return lessonAccess ? { ...lessonAccess, session } : null;
  });
}

export function enqueueAttemptGrading(db: Database, attempt: AssessmentAttemptRow, retry = false) {
  const payload: AssessmentGradingJobPayload = { attemptId: attempt.id };
  return enqueueJob(db, {
    queue: ASSESSMENT_GRADING_QUEUE,
    payload,
    idempotencyKey: retry
      ? `assessment-grading:${attempt.id}:retry:${attempt.updatedAt.getTime()}`
      : `assessment-grading:${attempt.id}`,
  });
}

/** Reset a failed open-response attempt so grading can run again. */
export async function resetFailedAttempt(
  db: Database,
  attemptId: string,
): Promise<AssessmentAttemptRow | null> {
  const [attempt] = await db
    .update(assessmentAttempts)
    .set({ status: "grading", errorCode: null, updatedAt: new Date() })
    .where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.status, "failed")))
    .returning();
  return attempt ?? null;
}

export async function markAttemptFailed(
  db: Database,
  attemptId: string,
  errorCode: string,
): Promise<boolean> {
  const rows = await db
    .update(assessmentAttempts)
    .set({ status: "failed", errorCode, updatedAt: new Date() })
    .where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.status, "grading")))
    .returning({ id: assessmentAttempts.id });
  return rows.length > 0;
}

export interface AttemptGrade {
  attemptId: string;
  userId: string;
  sessionId: string;
  conceptId: string;
  curriculumVersion: number;
  score: number;
  graderConfidence: number;
  grading: Record<string, unknown>;
  graderProvider: string | null;
  graderModel: string | null;
  graderVersion: string | null;
  occurredAt?: Date;
}

/**
 * Grade an attempt and record its mastery event exactly once. Safe to retry: an existing event for the
 * attempt is reused (a partial unique index backs this up), then the attempt is marked graded.
 */
export async function recordAttemptGrade(
  db: Database,
  grade: AttemptGrade,
): Promise<{ attempt: AssessmentAttemptRow; event: MasteryEventRow }> {
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.id, grade.attemptId));
  if (!attempt) throw new Error("Attempt not found");

  const findEvent = async () => {
    const [row] = await db
      .select()
      .from(masteryEvents)
      .where(eq(masteryEvents.assessmentAttemptId, grade.attemptId));
    return row ?? null;
  };

  let event = await findEvent();
  if (!event) {
    try {
      const recorded = await recordAssessmentEvidence(db, {
        userId: grade.userId,
        curriculumVersion: grade.curriculumVersion,
        assessmentAttemptId: grade.attemptId,
        evidence: {
          conceptId: grade.conceptId,
          kind: attempt.evidenceKind,
          mode: attempt.assessmentMode,
          score: grade.score,
          graderConfidence: grade.graderConfidence,
          sessionId: grade.sessionId,
          occurredAt: grade.occurredAt ?? new Date(),
        },
      });
      event = recorded.event;
    } catch (error) {
      event = await findEvent();
      if (!event) throw error;
    }
  }

  const now = new Date();
  const [graded] = await db
    .update(assessmentAttempts)
    .set({
      status: "graded",
      errorCode: null,
      score: grade.score,
      graderConfidence: grade.graderConfidence,
      grading: grade.grading,
      graderProvider: grade.graderProvider,
      graderModel: grade.graderModel,
      graderVersion: grade.graderVersion,
      masteryEventId: event.id,
      gradedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(assessmentAttempts.id, grade.attemptId),
        inArray(assessmentAttempts.status, ["grading", "failed"]),
      ),
    )
    .returning();
  if (graded) return { attempt: graded, event };
  const [current] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.id, grade.attemptId));
  return { attempt: current!, event };
}

/** "This grade seems wrong." Kept for review; the grade itself is unchanged. */
export async function flagAttempt(
  db: Database,
  input: { userId: string; attemptId: string; note: string | null },
): Promise<boolean> {
  const access = await getAttemptForUser(db, input.userId, input.attemptId);
  if (!access || access.attempt.status !== "graded") return false;
  const now = new Date();
  await db
    .update(assessmentAttempts)
    .set({ flaggedAt: now, flagNote: input.note?.slice(0, 1_000) ?? null, updatedAt: now })
    .where(eq(assessmentAttempts.id, input.attemptId));
  return true;
}

/** Mastery events recorded for a session's attempts, oldest first: the "what changed" view. */
export async function getMasteryEventsForAttempts(
  db: Database,
  userId: string,
  attemptIds: string[],
): Promise<MasteryEventRow[]> {
  if (attemptIds.length === 0) return [];
  return db
    .select()
    .from(masteryEvents)
    .where(
      and(eq(masteryEvents.userId, userId), inArray(masteryEvents.assessmentAttemptId, attemptIds)),
    )
    .orderBy(asc(masteryEvents.sequence));
}
