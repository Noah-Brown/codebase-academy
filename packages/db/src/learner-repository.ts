import type { CurriculumGraph } from "@academy/curriculum";
import {
  applyMasteryDelta,
  computeMasteryDelta,
  defaultLearningConfig,
  initialConceptState,
  type AssessmentEvidence,
  type LearnerConceptState,
  type LearningConfig,
  type MasteryDelta,
  type StartingLevel,
} from "@academy/learning";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import { learnerConceptStates, masteryEvents, users } from "./schema";

type StateRow = typeof learnerConceptStates.$inferSelect;
export type MasteryEventRow = typeof masteryEvents.$inferSelect;

function toState(row: StateRow): LearnerConceptState {
  return {
    conceptId: row.conceptId,
    priorAlpha: row.priorAlpha,
    priorBeta: row.priorBeta,
    alpha: row.alpha,
    beta: row.beta,
    evidenceCount: row.evidenceCount,
    evidenceWeight: row.evidenceWeight,
    sessionIds: row.sessionIds,
    demonstratedModes: row.demonstratedModes,
    highestModeDemonstrated: row.highestModeDemonstrated,
    lastAssessedAt: row.lastAssessedAt,
  };
}

function projectionColumns(state: LearnerConceptState) {
  return {
    alpha: state.alpha,
    beta: state.beta,
    evidenceCount: state.evidenceCount,
    evidenceWeight: state.evidenceWeight,
    sessionIds: state.sessionIds,
    demonstratedModes: state.demonstratedModes,
    highestModeDemonstrated: state.highestModeDemonstrated,
    lastAssessedAt: state.lastAssessedAt,
  };
}

/**
 * Record the starting level and create prior-only states for every concept.
 * Existing states are never reset, so re-running onboarding cannot erase evidence.
 */
export async function initializeLearner(
  db: Database,
  input: { userId: string; level: StartingLevel; graph: CurriculumGraph; config?: LearningConfig },
): Promise<{ created: number }> {
  const config = input.config ?? defaultLearningConfig;
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ startingLevel: input.level, updatedAt: new Date() })
      .where(eq(users.id, input.userId));

    const rows = input.graph.curriculum.concepts.map((concept) => {
      const state = initialConceptState(concept.id, concept.difficulty, input.level, config);
      return {
        userId: input.userId,
        conceptId: concept.id,
        curriculumVersion: input.graph.version,
        priorAlpha: state.priorAlpha,
        priorBeta: state.priorBeta,
        ...projectionColumns(state),
      };
    });
    const inserted = await tx
      .insert(learnerConceptStates)
      .values(rows)
      .onConflictDoNothing()
      .returning({ conceptId: learnerConceptStates.conceptId });
    return { created: inserted.length };
  });
}

export async function getLearnerStates(
  db: Database,
  userId: string,
): Promise<LearnerConceptState[]> {
  const rows = await db
    .select()
    .from(learnerConceptStates)
    .where(eq(learnerConceptStates.userId, userId));
  return rows.map(toState);
}

/** The level chosen during onboarding, or null before onboarding. */
export async function getStartingLevel(
  db: Database,
  userId: string,
): Promise<StartingLevel | null> {
  const [row] = await db
    .select({ startingLevel: users.startingLevel })
    .from(users)
    .where(eq(users.id, userId));
  return row?.startingLevel ?? null;
}

export class LearnerNotInitializedError extends Error {
  constructor(userId: string, conceptId: string) {
    super(
      `No learner state for user ${userId} and concept ${conceptId}; run initializeLearner first`,
    );
    this.name = "LearnerNotInitializedError";
  }
}

export interface RecordedEvidence {
  event: MasteryEventRow;
  delta: MasteryDelta;
  before: LearnerConceptState;
  after: LearnerConceptState;
}

/**
 * Append a mastery event for one completed assessment item and update the
 * projection atomically. Low-confidence grades are recorded but not applied.
 */
export async function recordAssessmentEvidence(
  db: Database,
  input: {
    userId: string;
    evidence: AssessmentEvidence;
    curriculumVersion: number;
    assessmentAttemptId?: string;
    config?: LearningConfig;
  },
): Promise<RecordedEvidence> {
  const config = input.config ?? defaultLearningConfig;
  const { evidence } = input;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(learnerConceptStates)
      .where(
        and(
          eq(learnerConceptStates.userId, input.userId),
          eq(learnerConceptStates.conceptId, evidence.conceptId),
        ),
      )
      .for("update");
    if (!row) throw new LearnerNotInitializedError(input.userId, evidence.conceptId);

    const before = toState(row);
    const delta = computeMasteryDelta(evidence, config);
    const after = applyMasteryDelta(before, evidence, delta, config);

    const [event] = await tx
      .insert(masteryEvents)
      .values({
        userId: input.userId,
        conceptId: evidence.conceptId,
        curriculumVersion: input.curriculumVersion,
        sessionId: evidence.sessionId,
        assessmentAttemptId: input.assessmentAttemptId ?? null,
        evidenceKind: evidence.kind,
        assessmentMode: evidence.mode,
        score: evidence.score,
        graderConfidence: evidence.graderConfidence,
        baseWeight: delta.baseWeight,
        confidenceFactor: delta.confidenceFactor,
        appliedWeight: delta.appliedWeight,
        alphaDelta: delta.alphaDelta,
        betaDelta: delta.betaDelta,
        alphaBefore: before.alpha,
        betaBefore: before.beta,
        alphaAfter: after.alpha,
        betaAfter: after.beta,
        applied: delta.applied,
        skipReason: delta.skipReason,
        occurredAt: evidence.occurredAt,
      })
      .returning();

    if (delta.applied) {
      await tx
        .update(learnerConceptStates)
        .set({
          ...projectionColumns(after),
          curriculumVersion: input.curriculumVersion,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(learnerConceptStates.userId, input.userId),
            eq(learnerConceptStates.conceptId, evidence.conceptId),
          ),
        );
    }

    return { event: event!, delta, before, after };
  });
}

export async function getMasteryEvents(
  db: Database,
  userId: string,
  conceptId: string,
): Promise<MasteryEventRow[]> {
  return db
    .select()
    .from(masteryEvents)
    .where(and(eq(masteryEvents.userId, userId), eq(masteryEvents.conceptId, conceptId)))
    .orderBy(asc(masteryEvents.sequence));
}

/**
 * Recompute a projection from its stored prior and the event log, applying each
 * event's recorded delta (not today's config) so history stays auditable.
 */
export async function replayLearnerConceptState(
  db: Database,
  userId: string,
  conceptId: string,
  config: LearningConfig = defaultLearningConfig,
): Promise<LearnerConceptState> {
  const [row] = await db
    .select()
    .from(learnerConceptStates)
    .where(
      and(eq(learnerConceptStates.userId, userId), eq(learnerConceptStates.conceptId, conceptId)),
    );
  if (!row) throw new LearnerNotInitializedError(userId, conceptId);

  const prior: LearnerConceptState = {
    ...toState(row),
    alpha: row.priorAlpha,
    beta: row.priorBeta,
    evidenceCount: 0,
    evidenceWeight: 0,
    sessionIds: [],
    demonstratedModes: [],
    highestModeDemonstrated: null,
    lastAssessedAt: null,
  };

  const events = await getMasteryEvents(db, userId, conceptId);
  return events.reduce(
    (state, event) =>
      applyMasteryDelta(
        state,
        {
          conceptId: event.conceptId,
          kind: event.evidenceKind,
          mode: event.assessmentMode,
          score: event.score,
          graderConfidence: event.graderConfidence,
          sessionId: event.sessionId,
          occurredAt: event.occurredAt,
        },
        {
          baseWeight: event.baseWeight,
          confidenceFactor: event.confidenceFactor,
          appliedWeight: event.appliedWeight,
          alphaDelta: event.alphaDelta,
          betaDelta: event.betaDelta,
          applied: event.applied,
          skipReason: event.skipReason as MasteryDelta["skipReason"],
        },
        config,
      ),
    prior,
  );
}
