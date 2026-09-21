import {
  MAX_ANSWER_CHARS,
  isAssessmentStep,
  lessonContentSchema,
  lessonSourcesSchema,
  revealFor,
  toPublicStep,
  type LessonContent,
  type LessonSources,
  type LessonStep,
} from "@academy/ai/lessons";
import { GENERATOR_VERSION } from "@academy/ai/versions";
import { getCurriculum } from "@academy/curriculum";
import {
  advanceSession,
  createAttempt,
  enqueueAttemptGrading,
  flagAttempt,
  getAnalysisForUser,
  getAttemptForUser,
  getConceptMappingForUser,
  getLatestSessionForLesson,
  getLearnerStates,
  getLessonForUser,
  getMasteryEventsForAttempts,
  getSessionForUser,
  getStartingLevel,
  listAttempts,
  listRecentLessonCompletions,
  recordAttemptGrade,
  requestLesson,
  resetFailedAttempt,
  startLessonSession,
  type AssessmentAttemptRow,
  type Database,
  type MasteryEventRow,
  type SessionAccess,
} from "@academy/db";
import {
  MASTERY_LABEL_TEXT,
  createLearnerView,
  defaultLearningConfig,
  describeMastery,
  evidenceKindFor,
  selectLesson,
} from "@academy/learning";
import { z } from "zod";
import { currentMappingVersions } from "./concept-mapping";
import type { AttemptView, LessonView } from "./lesson-view";

export type HttpResult<T> =
  { status: 200 | 202; body: T } | { status: 400 | 404 | 409; body: { error: string } };

const fail = (status: 400 | 404 | 409, error: string) => ({ status, body: { error } }) as const;

/** The mapping for one of the user's analyses, ranked for this learner right now. */
export async function loadLessonSelection(db: Database, userId: string, analysisId: string) {
  const view = await getConceptMappingForUser(db, userId, analysisId, currentMappingVersions());
  if (!view || view.run.status !== "succeeded") return { view, selection: null, level: null };
  const { graph } = getCurriculum();
  const level = (await getStartingLevel(db, userId)) ?? "intermediate";
  const now = new Date();
  const windowMs = defaultLearningConfig.ranking.recentLessonWindowHours * 3_600_000;
  const [states, recentLessons] = await Promise.all([
    getLearnerStates(db, userId),
    listRecentLessonCompletions(db, userId, new Date(now.getTime() - windowMs)),
  ]);
  const learner = createLearnerView(level, graph, states);
  return {
    view,
    level,
    selection: selectLesson({ mappings: view.mappings, graph, learner, recentLessons, now }),
  };
}

/**
 * Request a lesson on a mapped concept. The depth and evidence come from the server's own ranking of
 * the mapping, never from the client.
 */
export async function startLesson(
  db: Database,
  userId: string,
  analysisId: string,
  body: unknown,
): Promise<HttpResult<{ lessonId: string; status: string }>> {
  const parsed = z.object({ conceptId: z.string().min(1).max(200) }).safeParse(body);
  if (!parsed.success) return fail(400, "invalid_request");
  const access = await getAnalysisForUser(db, userId, analysisId);
  if (!access) return fail(404, "not_found");
  const { view, selection, level } = await loadLessonSelection(db, userId, access.analysis.id);
  if (!view || !selection || !level) return fail(409, "not_mapped");
  const candidate = selection.ranked.find((c) => c.conceptId === parsed.data.conceptId);
  if (!candidate) return fail(409, "concept_not_ranked");

  const sources: LessonSources = {
    pullRequestTitle: access.pullRequest.title,
    reasons: candidate.reasons,
    learner: {
      level,
      label: candidate.status.label,
      insufficientEvidence: candidate.status.insufficientEvidence,
    },
    evidence: candidate.mapping.evidence.map((item, index) => ({ id: `e${index + 1}`, ...item })),
  };
  const result = await requestLesson(db, {
    userId,
    analysisId: access.analysis.id,
    mappingRunId: view.run.id,
    conceptId: candidate.conceptId,
    curriculumVersion: view.run.curriculumVersion,
    depth: candidate.depth,
    generatorVersion: GENERATOR_VERSION,
    sources,
  });
  if (result.status === "not_found") return fail(404, "not_found");
  return { status: 202, body: { lessonId: result.lesson.id, status: result.lesson.status } };
}

const criterionResultsSchema = z.array(
  z.object({
    criterion: z.string(),
    met: z.enum(["yes", "partial", "no"]),
    evidenceFromAnswer: z.string(),
    verified: z.boolean(),
  }),
);

function toAttemptView(
  attempt: AssessmentAttemptRow,
  step: LessonStep | undefined,
  event: MasteryEventRow | undefined,
): AttemptView {
  const graded = attempt.status === "graded";
  const grading = (attempt.grading ?? {}) as Record<string, unknown>;
  const response = attempt.response as { choiceId?: unknown; text?: unknown };
  const criteria = criterionResultsSchema.safeParse(grading.criterionResults);
  return {
    id: attempt.id,
    stepIndex: attempt.stepIndex,
    status: attempt.status,
    errorCode: attempt.errorCode,
    responseKind: attempt.responseKind,
    choiceId: typeof response.choiceId === "string" ? response.choiceId : null,
    text: typeof response.text === "string" ? response.text : null,
    score: attempt.score,
    correct: typeof grading.correct === "boolean" ? grading.correct : null,
    feedback: typeof grading.feedback === "string" ? grading.feedback : null,
    criterionResults: criteria.success ? criteria.data : [],
    reveal: graded && step ? revealFor(step) : null,
    flagged: attempt.flaggedAt !== null,
    mastery: event
      ? { applied: event.applied, appliedWeight: event.appliedWeight, skipReason: event.skipReason }
      : null,
  };
}

function readyContent(lesson: { content: unknown }): LessonContent | null {
  const parsed = lessonContentSchema.safeParse(lesson.content);
  return parsed.success ? parsed.data : null;
}

/** Everything the lesson page renders, with answer keys only inside graded attempts. */
export async function loadLessonView(
  db: Database,
  userId: string,
  lessonId: string,
): Promise<LessonView | null> {
  const access = await getLessonForUser(db, userId, lessonId);
  if (!access) return null;
  const { lesson, pullRequest, repository } = access;
  const { graph } = getCurriculum();
  const header = {
    lessonId: lesson.id,
    analysisId: lesson.analysisId,
    conceptId: lesson.conceptId,
    conceptTitle: graph.get(lesson.conceptId)?.title ?? lesson.conceptId,
    repositoryFullName: repository.fullName,
    pullRequestNumber: pullRequest.number,
    pullRequestTitle: pullRequest.title,
  };
  const content = lesson.status === "ready" ? readyContent(lesson) : null;
  if (lesson.status !== "ready" || !content) {
    return {
      ...header,
      status: lesson.status === "ready" ? "failed" : lesson.status,
      errorCode: content || lesson.status !== "ready" ? lesson.errorCode : "lesson_invalid",
    };
  }

  const session = await getLatestSessionForLesson(db, userId, lesson.id);
  const attempts = session ? await listAttempts(db, session.id) : [];
  const events = await getMasteryEventsForAttempts(
    db,
    userId,
    attempts.map((attempt) => attempt.id),
  );
  const eventFor = new Map(events.map((event) => [event.assessmentAttemptId, event]));

  const level = (await getStartingLevel(db, userId)) ?? "intermediate";
  const learner = createLearnerView(level, graph, await getLearnerStates(db, userId));
  const now = describeMastery(learner.stateFor(lesson.conceptId), defaultLearningConfig);
  const sources = lessonSourcesSchema.safeParse(lesson.sources);
  const before = sources.success ? sources.data.learner : null;

  return {
    ...header,
    status: "ready",
    title: content.title,
    estimatedMinutes: content.estimatedMinutes,
    depth: content.depth,
    rationale: content.rationale,
    objectives: content.objectives,
    evidence: content.evidence,
    steps: content.steps.map(toPublicStep),
    session: session
      ? { id: session.id, status: session.status, currentStep: session.currentStep }
      : null,
    attempts: attempts.map((attempt) =>
      toAttemptView(attempt, content.steps[attempt.stepIndex], eventFor.get(attempt.id)),
    ),
    statusBefore: before
      ? {
          label: MASTERY_LABEL_TEXT[before.label],
          insufficientEvidence: before.insufficientEvidence,
        }
      : { label: MASTERY_LABEL_TEXT[now.label], insufficientEvidence: now.insufficientEvidence },
    statusNow: {
      label: MASTERY_LABEL_TEXT[now.label],
      insufficientEvidence: now.insufficientEvidence,
    },
  };
}

export async function lessonStatus(
  db: Database,
  userId: string,
  lessonId: string,
): Promise<HttpResult<{ status: string; errorCode: string | null }>> {
  const access = await getLessonForUser(db, userId, lessonId);
  if (!access) return fail(404, "not_found");
  return {
    status: 200,
    body: { status: access.lesson.status, errorCode: access.lesson.errorCode },
  };
}

export async function beginLesson(
  db: Database,
  userId: string,
  lessonId: string,
): Promise<HttpResult<{ sessionId: string; currentStep: number }>> {
  const result = await startLessonSession(db, { userId, lessonId });
  if (!("session" in result)) {
    return result.status === "not_ready" ? fail(409, "not_ready") : fail(404, "not_found");
  }
  return {
    status: 200,
    body: { sessionId: result.session.id, currentStep: result.session.currentStep },
  };
}

const submissionSchema = z.union([
  z.strictObject({ choiceId: z.string().min(1).max(64) }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ dontKnow: z.literal(true) }),
]);

type LoadedStep =
  | { ok: false; error: ReturnType<typeof fail> }
  | { ok: true; access: SessionAccess; content: LessonContent; step: LessonStep };

async function loadSessionStep(
  db: Database,
  userId: string,
  sessionId: string,
  stepIndex: number,
): Promise<LoadedStep> {
  const access = await getSessionForUser(db, userId, sessionId);
  if (!access) return { ok: false, error: fail(404, "not_found") };
  const content = readyContent(access.lesson);
  if (!content) return { ok: false, error: fail(409, "lesson_invalid") };
  const step = Number.isInteger(stepIndex) ? content.steps[stepIndex] : undefined;
  if (!step) return { ok: false, error: fail(404, "not_found") };
  return { ok: true, access, content, step };
}

async function attemptResult(
  db: Database,
  userId: string,
  attempt: AssessmentAttemptRow,
  step: LessonStep,
): Promise<HttpResult<{ attempt: AttemptView }>> {
  const [event] = await getMasteryEventsForAttempts(db, userId, [attempt.id]);
  return { status: 200, body: { attempt: toAttemptView(attempt, step, event) } };
}

/**
 * Answer the current step. Multiple choice and "I don't know" are graded here, deterministically; a
 * written answer is queued for the grader. One attempt per step: resubmitting returns the first,
 * except that a failed grading is retried.
 */
export async function submitStep(
  db: Database,
  userId: string,
  sessionId: string,
  stepIndex: number,
  body: unknown,
): Promise<HttpResult<{ attempt: AttemptView }>> {
  const loaded = await loadSessionStep(db, userId, sessionId, stepIndex);
  if (!loaded.ok) return loaded.error;
  const { access, step } = loaded;
  if (!isAssessmentStep(step)) return fail(409, "not_an_assessment");
  const submission = submissionSchema.safeParse(body);
  if (!submission.success) return fail(400, "invalid_request");
  const answer = submission.data;

  let responseKind: "choice" | "text" | "dont_know";
  let response: Record<string, unknown>;
  if ("dontKnow" in answer) {
    responseKind = "dont_know";
    response = {};
  } else if ("choiceId" in answer) {
    if (step.type !== "multiple_choice" || !step.choices.some((c) => c.id === answer.choiceId)) {
      return fail(400, "invalid_request");
    }
    responseKind = "choice";
    response = { choiceId: answer.choiceId };
  } else {
    const text = answer.text.trim();
    if (step.type !== "open_response" || text === "" || text.length > MAX_ANSWER_CHARS) {
      return fail(400, "invalid_request");
    }
    responseKind = "text";
    response = { text };
  }

  const { session, lesson } = access;
  // Only the current step accepts a new answer; an earlier step's answer is returned unchanged.
  const existing = (await listAttempts(db, session.id)).find((a) => a.stepIndex === stepIndex);
  if (!existing && (session.status !== "active" || session.currentStep !== stepIndex)) {
    return fail(409, "not_current_step");
  }
  const created = existing
    ? ({ status: "exists", attempt: existing } as const)
    : await createAttempt(db, {
        userId,
        sessionId: session.id,
        stepIndex,
        responseKind,
        response,
        evidenceKind: evidenceKindFor(
          step.type === "multiple_choice"
            ? { type: step.type, mode: step.mode }
            : { type: step.type, mode: step.mode, codeGrounded: step.evidenceIds.length > 0 },
        ),
        assessmentMode: step.mode,
      });
  let attempt = created.attempt;

  if (created.status === "exists") {
    if (attempt.status === "failed" && attempt.responseKind === "text") {
      const reset = await resetFailedAttempt(db, attempt.id);
      if (reset) {
        await enqueueAttemptGrading(db, attempt, true);
        attempt = reset;
      }
      return attemptResult(db, userId, attempt, step);
    }
    // A deterministic attempt left in "grading" by a crash is finished below; anything else is final.
    if (attempt.status !== "grading" || attempt.responseKind === "text") {
      return attemptResult(db, userId, attempt, step);
    }
  }

  if (attempt.responseKind === "text") {
    await enqueueAttemptGrading(db, attempt);
    return attemptResult(db, userId, attempt, step);
  }

  const dontKnow = attempt.responseKind === "dont_know";
  const chosen = (attempt.response as { choiceId?: string }).choiceId;
  const correct = !dontKnow && step.type === "multiple_choice" && chosen === step.correctChoiceId;
  const graded = await recordAttemptGrade(db, {
    attemptId: attempt.id,
    userId,
    sessionId: session.id,
    conceptId: lesson.conceptId,
    curriculumVersion: lesson.curriculumVersion,
    score: correct ? 1 : 0,
    graderConfidence: 1,
    grading: dontKnow ? { dontKnow: true } : { correct },
    graderProvider: null,
    graderModel: null,
    graderVersion: "deterministic",
  });
  return attemptResult(db, userId, graded.attempt, step);
}

/** Move past the current step. An assessment must be answered and graded first. */
export async function advanceLesson(
  db: Database,
  userId: string,
  sessionId: string,
  body: unknown,
): Promise<HttpResult<{ currentStep: number; status: string }>> {
  const parsed = z.object({ fromStep: z.number().int().nonnegative() }).safeParse(body);
  if (!parsed.success) return fail(400, "invalid_request");
  const { fromStep } = parsed.data;
  const loaded = await loadSessionStep(db, userId, sessionId, fromStep);
  if (!loaded.ok) return loaded.error;
  const { access, content, step } = loaded;
  if (access.session.status !== "active" || access.session.currentStep !== fromStep) {
    return fail(409, "not_current_step");
  }
  if (fromStep >= content.steps.length - 1) return fail(409, "lesson_finished");
  if (isAssessmentStep(step)) {
    const attempt = (await listAttempts(db, sessionId)).find((a) => a.stepIndex === fromStep);
    if (attempt?.status !== "graded") return fail(409, "answer_first");
  }
  // Reaching the takeaway completes the lesson: every check is behind it.
  const complete = fromStep + 1 === content.steps.length - 1;
  const session = await advanceSession(db, sessionId, { fromStep, complete });
  if (!session) return fail(409, "not_current_step");
  return { status: 200, body: { currentStep: session.currentStep, status: session.status } };
}

export async function attemptStatus(
  db: Database,
  userId: string,
  attemptId: string,
): Promise<HttpResult<{ attempt: AttemptView }>> {
  const access = await getAttemptForUser(db, userId, attemptId);
  if (!access) return fail(404, "not_found");
  const content = readyContent(access.lesson);
  return attemptResult(
    db,
    userId,
    access.attempt,
    content?.steps[access.attempt.stepIndex] ?? {
      type: "takeaway",
      points: [],
    },
  );
}

export async function flagGrade(
  db: Database,
  userId: string,
  attemptId: string,
  body: unknown,
): Promise<HttpResult<{ flagged: true }>> {
  const parsed = z.object({ note: z.string().max(1_000).optional() }).safeParse(body ?? {});
  if (!parsed.success) return fail(400, "invalid_request");
  const flagged = await flagAttempt(db, {
    userId,
    attemptId,
    note: parsed.data.note?.trim() || null,
  });
  return flagged ? { status: 200, body: { flagged: true } } : fail(404, "not_found");
}
