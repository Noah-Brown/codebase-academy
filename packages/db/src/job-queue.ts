import type { EnqueueOptions, JobHandler, JobQueue, Logger } from "@academy/shared";
import { and, asc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import { isErrorCode } from "./error-code";
import { jobs } from "./schema";

export type JobRow = typeof jobs.$inferSelect;

export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Delay before the next attempt after `attempts` failed claims: min(2^attempts × 5s, 10 min). */
export function jobRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * BACKOFF_BASE_MS, BACKOFF_MAX_MS);
}

/** The code stored for a handler failure. Messages are never persisted. */
export function jobErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return isErrorCode(code) ? code : "handler_error";
}

/**
 * Insert a job. With an idempotency key that already exists (in any status), nothing is inserted
 * and the existing job's ID is returned.
 */
export async function enqueueJob(
  db: Database,
  input: {
    queue: string;
    payload: unknown;
    idempotencyKey?: string;
    maxAttempts?: number;
    runAfter?: Date;
  },
): Promise<{ jobId: string; created: boolean }> {
  const [inserted] = await db
    .insert(jobs)
    .values({
      queue: input.queue,
      payload: input.payload ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
      ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  if (inserted) return { jobId: inserted.id, created: true };

  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, input.idempotencyKey!));
  if (!existing) throw new Error("Job idempotency conflict without an existing job");
  return { jobId: existing.id, created: false };
}

/**
 * Atomically claim the next runnable job: queued and due, or running with an expired lease.
 * Claiming increments `attempts`, so a worker that crashes mid-job still uses up an attempt;
 * an expired job that has no attempts left is marked `failed` (`lease_expired`) instead.
 */
export async function claimNextJob(
  db: Database,
  options: { queues: string[]; leaseMs: number; now?: Date },
): Promise<JobRow | null> {
  if (options.queues.length === 0) return null;
  const now = options.now ?? new Date();

  await db
    .update(jobs)
    .set({
      status: "failed",
      lastErrorCode: "lease_expired",
      lockedUntil: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(jobs.queue, options.queues),
        eq(jobs.status, "running"),
        lt(jobs.lockedUntil, now),
        gte(jobs.attempts, jobs.maxAttempts),
      ),
    );

  const candidate = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.queue, options.queues),
        or(
          and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)),
          and(
            eq(jobs.status, "running"),
            lt(jobs.lockedUntil, now),
            lt(jobs.attempts, jobs.maxAttempts),
          ),
        ),
      ),
    )
    .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });

  const [job] = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: new Date(now.getTime() + options.leaseMs),
      updatedAt: now,
    })
    .where(sql`${jobs.id} = (${candidate})`)
    .returning();
  return job ?? null;
}

/** Push a running job's lease forward (heartbeat for long handlers). */
export async function extendJobLease(
  db: Database,
  jobId: string,
  options: { leaseMs: number; now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(jobs)
    .set({ lockedUntil: new Date(now.getTime() + options.leaseMs), updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function completeJob(
  db: Database,
  jobId: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(jobs)
    .set({ status: "succeeded", lockedUntil: null, completedAt: now, updatedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Record a failed attempt: reschedule with exponential backoff, or mark `failed` once
 * `attempts` reaches `max_attempts`. Returns null if the job is not running.
 */
export async function failJob(
  db: Database,
  jobId: string,
  options: { errorCode: string; now?: Date },
): Promise<{ status: "queued" | "failed"; runAfter: Date } | null> {
  const now = options.now ?? new Date();
  const errorCode = isErrorCode(options.errorCode) ? options.errorCode : "handler_error";
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
      .for("update");
    if (!job) return null;

    const terminal = job.attempts >= job.maxAttempts;
    const runAfter = terminal
      ? job.runAfter
      : new Date(now.getTime() + jobRetryDelayMs(job.attempts));
    await tx
      .update(jobs)
      .set({
        status: terminal ? "failed" : "queued",
        runAfter,
        lockedUntil: null,
        lastErrorCode: errorCode,
        completedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId));
    return { status: terminal ? "failed" : "queued", runAfter };
  });
}

export interface PgJobQueueOptions {
  /** Idle delay between polls when no job is available. Default 1s. */
  pollIntervalMs?: number;
  /** Lease per claim, renewed every half lease while the handler runs. Default 5 min. */
  leaseMs?: number;
  logger?: Logger;
  now?: () => Date;
}

/**
 * Postgres-backed `JobQueue` (D20). `enqueue`'s `retryLimit` sets `max_attempts` (total attempts).
 * Each `work` call starts one sequential poller for that queue; `stop` waits for running handlers.
 */
export function createPgJobQueue(db: Database, options: PgJobQueueOptions = {}): JobQueue {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;

  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();

  const track = (promise: Promise<void>) => {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  };

  const schedule = (fn: () => void, delayMs: number) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delayMs);
    timers.add(timer);
  };

  async function runOne<Payload>(queue: string, handler: JobHandler<Payload>): Promise<boolean> {
    const job = await claimNextJob(db, { queues: [queue], leaseMs, now: now() });
    if (!job) return false;

    let heartbeat: Promise<unknown> = Promise.resolve();
    const interval = setInterval(
      () => {
        heartbeat = extendJobLease(db, job.id, { leaseMs, now: now() }).catch((error: unknown) =>
          logger?.warn("job lease renewal failed", {
            queue,
            jobId: job.id,
            errorCode: jobErrorCode(error),
          }),
        );
      },
      Math.max(Math.floor(leaseMs / 2), 1),
    );

    let failure: { error: unknown } | null = null;
    try {
      await handler(job.payload as Payload, { jobId: job.id, attempt: job.attempts });
    } catch (error) {
      failure = { error };
    } finally {
      clearInterval(interval);
      await heartbeat;
    }

    if (!failure) {
      await completeJob(db, job.id, { now: now() });
      logger?.debug("job succeeded", { queue, jobId: job.id, attempt: job.attempts });
    } else {
      const errorCode = jobErrorCode(failure.error);
      const result = await failJob(db, job.id, { errorCode, now: now() });
      logger?.warn("job failed", {
        queue,
        jobId: job.id,
        attempt: job.attempts,
        errorCode,
        nextStatus: result?.status ?? null,
      });
    }
    return true;
  }

  return {
    async enqueue<Payload>(name: string, payload: Payload, enqueueOptions: EnqueueOptions = {}) {
      const { jobId } = await enqueueJob(db, {
        queue: name,
        payload,
        idempotencyKey: enqueueOptions.idempotencyKey,
        maxAttempts: enqueueOptions.retryLimit,
        runAfter: enqueueOptions.startAfter,
      });
      return jobId;
    },

    async work<Payload>(name: string, handler: JobHandler<Payload>) {
      if (stopped) return;
      const tick = () => {
        if (stopped) return;
        track(
          runOne(name, handler).then(
            (processed) => schedule(tick, processed ? 0 : pollIntervalMs),
            (error: unknown) => {
              logger?.error("job queue poll failed", {
                queue: name,
                errorCode: jobErrorCode(error),
              });
              schedule(tick, pollIntervalMs);
            },
          ),
        );
      };
      tick();
    },

    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
