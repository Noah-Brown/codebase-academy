import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./client";
import {
  claimNextJob,
  completeJob,
  createPgJobQueue,
  enqueueJob,
  failJob,
  jobRetryDelayMs,
} from "./job-queue";
import { jobs } from "./schema";
import { createTestDatabase } from "./testing";

let handle: DatabaseHandle;
const queueName = () => `test-${crypto.randomUUID()}`;
const t0 = new Date("2026-09-14T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const LEASE = 60_000;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function getJob(id: string) {
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("enqueue", () => {
  it("returns the existing job for a repeated idempotency key", async () => {
    const queue = queueName();
    const key = `pr-analysis:${crypto.randomUUID()}`;
    const first = await enqueueJob(handle.db, { queue, payload: { n: 1 }, idempotencyKey: key });
    const second = await enqueueJob(handle.db, { queue, payload: { n: 2 }, idempotencyKey: key });
    expect(first.created).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, created: false });
    expect(await getJob(first.jobId)).toMatchObject({
      queue,
      payload: { n: 1 },
      idempotencyKey: key,
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
    });
  });

  it("does not deduplicate jobs without a key", async () => {
    const queue = queueName();
    const a = await enqueueJob(handle.db, { queue, payload: {} });
    const b = await enqueueJob(handle.db, { queue, payload: {} });
    expect(a.jobId).not.toBe(b.jobId);
  });
});

describe("claiming", () => {
  it("claims due jobs in run_after order and only from the requested queues", async () => {
    const queue = queueName();
    const later = await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1_000) });
    const earlier = await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-5_000) });
    await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(10_000) });
    await enqueueJob(handle.db, { queue: queueName(), payload: {}, runAfter: at(-10_000) });

    const first = await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    const second = await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    const third = await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    expect(first?.id).toBe(earlier.jobId);
    expect(second?.id).toBe(later.jobId);
    expect(third).toBeNull();
    expect(first).toMatchObject({ status: "running", attempts: 1, lockedUntil: at(LEASE) });
  });

  it("never gives the same job to two concurrent claimers", async () => {
    const queue = queueName();
    await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1) });
    const claims = await Promise.all(
      Array.from({ length: 2 }, () =>
        claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1) });
    await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1) });
    const pair = await Promise.all(
      Array.from({ length: 3 }, () =>
        claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 }),
      ),
    );
    const ids = pair.filter(Boolean).map((job) => job!.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("reclaims a job whose lease expired", async () => {
    const queue = queueName();
    const { jobId } = await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1) });
    await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    expect(
      await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: at(LEASE - 1) }),
    ).toBeNull();

    const reclaimed = await claimNextJob(handle.db, {
      queues: [queue],
      leaseMs: LEASE,
      now: at(LEASE + 1),
    });
    expect(reclaimed).toMatchObject({ id: jobId, attempts: 2, lockedUntil: at(2 * LEASE + 1) });
  });

  it("fails an expired job that has no attempts left instead of reclaiming it", async () => {
    const queue = queueName();
    const { jobId } = await enqueueJob(handle.db, {
      queue,
      payload: {},
      maxAttempts: 1,
      runAfter: at(-1),
    });
    await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    expect(
      await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: at(LEASE + 1) }),
    ).toBeNull();
    expect(await getJob(jobId)).toMatchObject({ status: "failed", lastErrorCode: "lease_expired" });
  });
});

describe("completion and failure", () => {
  it("marks a job succeeded", async () => {
    const queue = queueName();
    const { jobId } = await enqueueJob(handle.db, { queue, payload: {}, runAfter: at(-1) });
    await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: t0 });
    expect(await completeJob(handle.db, jobId, { now: at(5) })).toBe(true);
    expect(await getJob(jobId)).toMatchObject({
      status: "succeeded",
      lockedUntil: null,
      completedAt: at(5),
    });
    expect(await completeJob(handle.db, jobId)).toBe(false);
  });

  it("backs off exponentially, capped at ten minutes", () => {
    expect([1, 2, 3, 6, 7, 20].map(jobRetryDelayMs)).toEqual([
      10_000, 20_000, 40_000, 320_000, 600_000, 600_000,
    ]);
  });

  it("reschedules failed attempts and fails terminally at max attempts", async () => {
    const queue = queueName();
    const { jobId } = await enqueueJob(handle.db, {
      queue,
      payload: {},
      maxAttempts: 3,
      runAfter: at(-1),
    });

    let now = t0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const job = await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now });
      expect(job).toMatchObject({ id: jobId, attempts: attempt });
      const result = await failJob(handle.db, jobId, { errorCode: "github_timeout", now });
      const expectedRunAfter = new Date(now.getTime() + 2 ** attempt * 5_000);
      expect(result).toEqual({ status: "queued", runAfter: expectedRunAfter });
      expect(await getJob(jobId)).toMatchObject({
        status: "queued",
        attempts: attempt,
        runAfter: expectedRunAfter,
        lockedUntil: null,
        lastErrorCode: "github_timeout",
      });
      // Not claimable before the backoff elapses.
      expect(
        await claimNextJob(handle.db, {
          queues: [queue],
          leaseMs: LEASE,
          now: new Date(expectedRunAfter.getTime() - 1),
        }),
      ).toBeNull();
      now = expectedRunAfter;
    }

    await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now });
    const final = await failJob(handle.db, jobId, { errorCode: "not a code!", now });
    expect(final?.status).toBe("failed");
    expect(await getJob(jobId)).toMatchObject({
      status: "failed",
      attempts: 3,
      lastErrorCode: "handler_error",
    });
    expect(
      await claimNextJob(handle.db, { queues: [queue], leaseMs: LEASE, now: at(86_400_000) }),
    ).toBeNull();
  });
});

describe("createPgJobQueue", () => {
  it("processes an enqueued job end to end", async () => {
    const queue = createPgJobQueue(handle.db, { pollIntervalMs: 10, leaseMs: LEASE });
    const name = queueName();
    const jobId = await queue.enqueue(
      name,
      { prId: "abc" },
      { idempotencyKey: crypto.randomUUID() },
    );

    const seen: Array<{ payload: unknown; jobId: string; attempt: number }> = [];
    await queue.work<{ prId: string }>(name, async (payload, context) => {
      seen.push({ payload, ...context });
    });
    await waitFor(async () => (await getJob(jobId)).status === "succeeded");
    await queue.stop();
    expect(seen).toEqual([{ payload: { prId: "abc" }, jobId, attempt: 1 }]);
  });

  it("stores the error code (not the message) and retries later", async () => {
    const queue = createPgJobQueue(handle.db, { pollIntervalMs: 10, leaseMs: LEASE });
    const name = queueName();
    const withCode = await queue.enqueue(name, { kind: "coded" }, { retryLimit: 2 });
    const plain = await queue.enqueue(name, { kind: "plain" });

    await queue.work<{ kind: string }>(name, async (payload) => {
      if (payload.kind === "coded") {
        throw Object.assign(new Error("password = hunter2"), { code: "github_not_found" });
      }
      throw new Error("const token = 'secret'");
    });
    await waitFor(
      async () => (await getJob(plain)).attempts === 1 && (await getJob(plain)).status === "queued",
    );
    await queue.stop();

    expect(await getJob(withCode)).toMatchObject({
      status: "queued",
      attempts: 1,
      maxAttempts: 2,
      lastErrorCode: "github_not_found",
    });
    const plainJob = await getJob(plain);
    expect(plainJob.lastErrorCode).toBe("handler_error");
    expect(plainJob.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("waits for the in-flight handler when stopping", async () => {
    const queue = createPgJobQueue(handle.db, { pollIntervalMs: 10, leaseMs: LEASE });
    const name = queueName();
    const jobId = await queue.enqueue(name, {});

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    await queue.work(name, async () => {
      started = true;
      await gate;
    });
    await waitFor(async () => started);

    let stopped = false;
    const stopping = queue.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await getJob(jobId)).status).toBe("succeeded");
  });
});
