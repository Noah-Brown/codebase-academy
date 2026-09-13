/**
 * Background-job boundary. Product code enqueues and handles jobs only through
 * this interface; the durable implementation (Postgres-backed) lands in Milestone 2.
 */

export interface EnqueueOptions {
  /**
   * Deduplication key. Enqueueing a job whose key matches an unfinished job is a no-op,
   * e.g. `pr-analysis:${repoId}:${prNumber}:${headSha}:${analyzerVersion}`.
   */
  idempotencyKey?: string;
  retryLimit?: number;
  startAfter?: Date;
}

export interface JobContext {
  jobId: string;
  attempt: number;
}

export type JobHandler<Payload> = (payload: Payload, context: JobContext) => Promise<void>;

export interface JobQueue {
  enqueue<Payload>(name: string, payload: Payload, options?: EnqueueOptions): Promise<string>;
  work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void>;
  stop(): Promise<void>;
}
