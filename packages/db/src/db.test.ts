import { getCurriculum, type Curriculum } from "@academy/curriculum";
import { defaultLearningConfig as config, type AssessmentEvidence } from "@academy/learning";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./client";
import {
  CurriculumVersionConflictError,
  curriculumContentHash,
  getLatestCurriculumVersion,
  importCurriculum,
} from "./curriculum-repository";
import {
  LearnerNotInitializedError,
  getLearnerStates,
  getMasteryEvents,
  initializeLearner,
  recordAssessmentEvidence,
  replayLearnerConceptState,
} from "./learner-repository";
import { linkVerifiedUserInstallation, upsertInstallation } from "./github-repository";
import {
  accounts,
  curriculumConcepts,
  curriculumPrerequisites,
  githubInstallations,
  learnerConceptStates,
  masteryEvents,
  sessions,
  userInstallations,
  users,
} from "./schema";
import { createTestDatabase } from "./testing";

const { curriculum, graph } = getCurriculum();
let handle: DatabaseHandle;
let userId: string;

const evidence = (overrides: Partial<AssessmentEvidence> = {}): AssessmentEvidence => ({
  conceptId: "web.idempotency",
  kind: "code_grounded_open_response",
  mode: "explain",
  score: 0.8,
  graderConfidence: 0.9,
  sessionId: "session-1",
  occurredAt: new Date("2026-09-13T12:00:00Z"),
  ...overrides,
});

beforeAll(async () => {
  handle = await createTestDatabase();
  await importCurriculum(handle.db, curriculum);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  const [user] = await handle.db
    .insert(users)
    .values({ name: "Test Learner", email: `${crypto.randomUUID()}@example.test` })
    .returning();
  userId = user!.id;
});

describe("curriculum import", () => {
  it("imports every concept and prerequisite edge", async () => {
    const [concepts] = await handle.db.select({ n: count() }).from(curriculumConcepts);
    const [edges] = await handle.db.select({ n: count() }).from(curriculumPrerequisites);
    expect(concepts!.n).toBe(curriculum.concepts.length);
    expect(edges!.n).toBe(curriculum.concepts.reduce((sum, c) => sum + c.prerequisites.length, 0));
    expect(await getLatestCurriculumVersion(handle.db)).toBe(curriculum.version);
  });

  it("is idempotent for identical content", async () => {
    const again = await importCurriculum(handle.db, curriculum);
    expect(again.status).toBe("unchanged");
  });

  it("hashes content independently of authoring order", () => {
    const reordered: Curriculum = { ...curriculum, concepts: [...curriculum.concepts].reverse() };
    expect(curriculumContentHash(reordered)).toBe(curriculumContentHash(curriculum));
  });

  it("refuses to change a published version", async () => {
    const edited: Curriculum = {
      ...curriculum,
      concepts: curriculum.concepts.map((c, i) =>
        i === 0 ? { ...c, title: `${c.title} (edited)` } : c,
      ),
    };
    await expect(importCurriculum(handle.db, edited)).rejects.toThrow(
      CurriculumVersionConflictError,
    );
  });
});

describe("learner initialization", () => {
  it("creates prior-only states for every concept from the starting level", async () => {
    const { created } = await initializeLearner(handle.db, { userId, level: "advanced", graph });
    expect(created).toBe(curriculum.concepts.length);

    const states = await getLearnerStates(handle.db, userId);
    const backpressure = states.find((s) => s.conceptId === "systems.backpressure")!;
    expect(backpressure).toMatchObject({
      alpha: config.priors.advanced[5].alpha,
      beta: config.priors.advanced[5].beta,
      evidenceCount: 0,
    });
    const [user] = await handle.db.select().from(users).where(eq(users.id, userId));
    expect(user!.startingLevel).toBe("advanced");
  });

  it("never resets existing evidence when onboarding runs again", async () => {
    await initializeLearner(handle.db, { userId, level: "novice", graph });
    await recordAssessmentEvidence(handle.db, {
      userId,
      evidence: evidence(),
      curriculumVersion: curriculum.version,
    });

    const rerun = await initializeLearner(handle.db, { userId, level: "advanced", graph });
    expect(rerun.created).toBe(0);
    const state = (await getLearnerStates(handle.db, userId)).find(
      (s) => s.conceptId === "web.idempotency",
    );
    expect(state!.evidenceCount).toBe(1);
  });
});

describe("recording assessment evidence", () => {
  beforeEach(async () => {
    await initializeLearner(handle.db, { userId, level: "intermediate", graph });
  });

  it("appends an auditable event and updates the projection atomically", async () => {
    const recorded = await recordAssessmentEvidence(handle.db, {
      userId,
      evidence: evidence(),
      curriculumVersion: curriculum.version,
      assessmentAttemptId: "attempt-1",
    });

    expect(recorded.delta.applied).toBe(true);
    expect(recorded.event).toMatchObject({
      userId,
      conceptId: "web.idempotency",
      curriculumVersion: curriculum.version,
      evidenceKind: "code_grounded_open_response",
      applied: true,
      alphaBefore: recorded.before.alpha,
      alphaAfter: recorded.after.alpha,
      assessmentAttemptId: "attempt-1",
    });
    expect(recorded.event.alphaAfter - recorded.event.alphaBefore).toBeCloseTo(
      recorded.delta.alphaDelta,
    );

    const [row] = await handle.db
      .select()
      .from(learnerConceptStates)
      .where(
        and(
          eq(learnerConceptStates.conceptId, "web.idempotency"),
          eq(learnerConceptStates.userId, userId),
        ),
      );
    expect(row).toMatchObject({
      alpha: recorded.after.alpha,
      beta: recorded.after.beta,
      evidenceCount: 1,
    });
    expect(row!.sessionIds).toEqual(["session-1"]);
  });

  it("records low-confidence grades without changing mastery", async () => {
    const recorded = await recordAssessmentEvidence(handle.db, {
      userId,
      evidence: evidence({ graderConfidence: 0.1 }),
      curriculumVersion: curriculum.version,
    });
    expect(recorded.event).toMatchObject({
      applied: false,
      skipReason: "low_grader_confidence",
      appliedWeight: 0,
    });
    expect(recorded.after).toEqual(recorded.before);
    const events = await getMasteryEvents(handle.db, userId, "web.idempotency");
    expect(events).toHaveLength(1);
  });

  it("rebuilds the stored projection exactly by replaying events", async () => {
    const items = [
      evidence({ kind: "multiple_choice", mode: "recognize", score: 1 }),
      evidence({ score: 0.3, sessionId: "session-2" }),
      evidence({ graderConfidence: 0.2 }),
      evidence({ kind: "engineering_defense", mode: "defend", score: 0.9, sessionId: "session-2" }),
    ];
    for (const item of items) {
      await recordAssessmentEvidence(handle.db, {
        userId,
        evidence: item,
        curriculumVersion: curriculum.version,
      });
    }
    const stored = (await getLearnerStates(handle.db, userId)).find(
      (s) => s.conceptId === "web.idempotency",
    )!;
    const replayed = await replayLearnerConceptState(handle.db, userId, "web.idempotency");
    expect(replayed.alpha).toBeCloseTo(stored.alpha, 10);
    expect(replayed.beta).toBeCloseTo(stored.beta, 10);
    expect({ ...replayed, alpha: 0, beta: 0 }).toEqual({ ...stored, alpha: 0, beta: 0 });
  });

  it("serializes concurrent updates to the same concept without losing evidence", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordAssessmentEvidence(handle.db, {
          userId,
          evidence: evidence({ sessionId: `s${i}` }),
          curriculumVersion: curriculum.version,
        }),
      ),
    );
    const state = (await getLearnerStates(handle.db, userId)).find(
      (s) => s.conceptId === "web.idempotency",
    )!;
    expect(state.evidenceCount).toBe(5);
    expect(state.evidenceWeight).toBeCloseTo(5 * 1.3);
  });

  it("requires an initialized learner", async () => {
    const [stranger] = await handle.db
      .insert(users)
      .values({ name: "No onboarding", email: `${crypto.randomUUID()}@example.test` })
      .returning();
    await expect(
      recordAssessmentEvidence(handle.db, {
        userId: stranger!.id,
        evidence: evidence(),
        curriculumVersion: curriculum.version,
      }),
    ).rejects.toThrow(LearnerNotInitializedError);
  });
});

describe("database invariants", () => {
  beforeEach(async () => {
    await initializeLearner(handle.db, { userId, level: "intermediate", graph });
    await recordAssessmentEvidence(handle.db, {
      userId,
      evidence: evidence(),
      curriculumVersion: curriculum.version,
    });
  });

  it("makes mastery_events append-only", async () => {
    const error = await handle.db
      .update(masteryEvents)
      .set({ score: 1 })
      .where(eq(masteryEvents.userId, userId))
      .then(
        () => null,
        (e: unknown) => e,
      );
    // Drizzle wraps driver errors; the trigger's message is on the cause.
    expect(String((error as Error | null)?.cause)).toMatch(/append-only/);
    const [event] = await getMasteryEvents(handle.db, userId, "web.idempotency");
    expect(event!.score).toBe(0.8);
  });

  it("rejects events for concepts that are not in the recorded curriculum version", async () => {
    await expect(
      handle.db.execute(sql`
        insert into mastery_events (user_id, concept_id, curriculum_version, evidence_kind, assessment_mode,
          score, grader_confidence, base_weight, confidence_factor, applied_weight, alpha_delta, beta_delta,
          alpha_before, beta_before, alpha_after, beta_after, applied, occurred_at)
        values (${userId}, 'web.invented', ${curriculum.version}, 'multiple_choice', 'recognize',
          1, 1, 0.5, 1, 0.5, 0.5, 0, 1, 1, 1.5, 1, true, now())`),
    ).rejects.toThrow();
  });

  it("rejects out-of-range scores at the database level", async () => {
    await expect(
      handle.db.execute(sql`
        insert into mastery_events (user_id, concept_id, curriculum_version, evidence_kind, assessment_mode,
          score, grader_confidence, base_weight, confidence_factor, applied_weight, alpha_delta, beta_delta,
          alpha_before, beta_before, alpha_after, beta_after, applied, occurred_at)
        values (${userId}, 'web.idempotency', ${curriculum.version}, 'multiple_choice', 'recognize',
          1.5, 1, 0.5, 1, 0.5, 0.5, 0, 1, 1, 1.5, 1, true, now())`),
    ).rejects.toThrow();
  });

  it("deletes all learner data when the user is deleted", async () => {
    await handle.db.delete(users).where(eq(users.id, userId));
    expect(await getMasteryEvents(handle.db, userId, "web.idempotency")).toEqual([]);
    expect(await getLearnerStates(handle.db, userId)).toEqual([]);
  });

  it("stores Better Auth rows and cascades them, and installation links, on user deletion", async () => {
    const now = new Date();
    const [user] = await handle.db.select().from(users).where(eq(users.id, userId));
    expect(user!.emailVerified).toBe(false);

    await handle.db.insert(sessions).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(accounts).values({
      id: crypto.randomUUID(),
      accountId: "12345",
      providerId: "github",
      userId,
      accessToken: "gho_test",
      createdAt: now,
      updatedAt: now,
    });
    const installationId = 424242;
    await upsertInstallation(handle.db, {
      id: installationId,
      accountLogin: "acme",
      accountType: "User",
    });
    await linkVerifiedUserInstallation(handle.db, { userId, installationId });

    await handle.db.delete(users).where(eq(users.id, userId));

    for (const table of [
      sessions,
      accounts,
      userInstallations,
      learnerConceptStates,
      masteryEvents,
    ]) {
      const [row] = await handle.db
        .select({ n: count() })
        .from(table)
        .where(eq(table.userId, userId));
      expect(row!.n).toBe(0);
    }
    // Installations are global and survive.
    const [installation] = await handle.db
      .select({ n: count() })
      .from(githubInstallations)
      .where(eq(githubInstallations.id, installationId));
    expect(installation!.n).toBe(1);
  });
});
