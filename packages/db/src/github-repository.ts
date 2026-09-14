import { and, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client";
import { assertErrorCode } from "./error-code";
import {
  githubInstallations,
  prAnalyses,
  pullRequests,
  repositories,
  userInstallations,
  type AnalysisStatus,
  type PullRequestState,
} from "./schema";

export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;
export type UserInstallationRow = typeof userInstallations.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type PrAnalysisRow = typeof prAnalyses.$inferSelect;

export interface InstallationInput {
  id: number;
  accountLogin: string;
  accountType: string;
  /** When provided, overwrites the suspension state (e.g. from GET /app/installations/:id). */
  suspendedAt?: Date | null;
}

export interface RepositoryInput {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  /** Webhook deltas omit it; an existing value is kept when this is missing. */
  defaultBranch?: string | null;
  private: boolean;
}

export interface PullRequestInput {
  number: number;
  title: string;
  authorLogin: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  state: PullRequestState;
  githubUpdatedAt: Date;
}

export type RepositoryWithInstallation = RepositoryRow & { installation: GitHubInstallationRow };

export interface PullRequestAccess {
  pullRequest: PullRequestRow;
  repository: RepositoryRow;
  installation: GitHubInstallationRow;
}

export interface AnalysisAccess extends PullRequestAccess {
  analysis: PrAnalysisRow;
}

export type AnalysisSummary = Pick<
  PrAnalysisRow,
  | "id"
  | "status"
  | "analyzerVersion"
  | "headSha"
  | "errorCode"
  | "estimatedTokens"
  | "createdAt"
  | "updatedAt"
>;

export type PullRequestWithLatestAnalysis = PullRequestRow & {
  /** Latest analysis for the PR's current head SHA (any analyzer version), if any. */
  latestAnalysis: AnalysisSummary | null;
};

export type RequestAnalysisResult =
  | { status: "created" | "existing"; analysis: PrAnalysisRow }
  | { status: "not_found" }
  | { status: "installation_suspended" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IDs from URLs are untrusted; a malformed one is simply "not found", never a query error. */
const isUuid = (value: string) => UUID_PATTERN.test(value);

/**
 * The tenancy rule, used by every user-scoped read. Queries must inner-join
 * user_installations and github_installations on the repository's installation.
 */
function userCanAccessRepository(userId: string): SQL {
  return and(
    eq(userInstallations.userId, userId),
    isNull(githubInstallations.deletedAt),
    isNull(repositories.removedAt),
  )!;
}

// ---------------------------------------------------------------------------
// Installations (global rows; written from verified GitHub data only)
// ---------------------------------------------------------------------------

/** Create or refresh an installation. A (re)created installation is no longer deleted. */
export async function upsertInstallation(
  db: Database,
  input: InstallationInput,
): Promise<GitHubInstallationRow> {
  const now = new Date();
  const fields = {
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    deletedAt: null,
    updatedAt: now,
    ...(input.suspendedAt !== undefined ? { suspendedAt: input.suspendedAt } : {}),
  };
  const [row] = await db
    .insert(githubInstallations)
    .values({ id: input.id, ...fields })
    .onConflictDoUpdate({ target: githubInstallations.id, set: fields })
    .returning();
  return row!;
}

export async function markInstallationDeleted(db: Database, id: number): Promise<void> {
  const now = new Date();
  await db
    .update(githubInstallations)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(githubInstallations.id, id), isNull(githubInstallations.deletedAt)));
}

export async function setInstallationSuspended(
  db: Database,
  id: number,
  suspended: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubInstallations)
    .set({
      suspendedAt: suspended ? sql`coalesce(${githubInstallations.suspendedAt}, ${now})` : null,
      updatedAt: now,
    })
    .where(eq(githubInstallations.id, id));
}

/**
 * Grant a user access to an installation's repositories.
 *
 * SECURITY: the caller MUST have verified that GitHub's `GET /user/installations`, called with
 * this user's own GitHub token, lists `installationId`. Never pass an installation ID taken from
 * a query string or other client input without that check. The installation row must exist
 * (call `upsertInstallation` first).
 */
export async function linkVerifiedUserInstallation(
  db: Database,
  input: { userId: string; installationId: number },
): Promise<UserInstallationRow> {
  const now = new Date();
  const [row] = await db
    .insert(userInstallations)
    .values({ userId: input.userId, installationId: input.installationId, verifiedAt: now })
    .onConflictDoUpdate({
      target: [userInstallations.userId, userInstallations.installationId],
      set: { verifiedAt: now },
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

async function upsertRepositoryRows(
  db: Database,
  installationId: number,
  repos: RepositoryInput[],
  now: Date,
): Promise<number> {
  const unique = [...new Map(repos.map((repo) => [repo.id, repo])).values()];
  if (unique.length === 0) return 0;
  const rows = await db
    .insert(repositories)
    .values(
      unique.map((repo) => ({
        id: repo.id,
        installationId,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch ?? null,
        private: repo.private,
        removedAt: null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: repositories.id,
      set: {
        installationId: sql`excluded.installation_id`,
        owner: sql`excluded.owner`,
        name: sql`excluded.name`,
        fullName: sql`excluded.full_name`,
        defaultBranch: sql`coalesce(excluded.default_branch, ${repositories.defaultBranch})`,
        private: sql`excluded.private`,
        removedAt: null,
        updatedAt: now,
      },
    })
    .returning({ id: repositories.id });
  return rows.length;
}

/**
 * Make the stored repository set of an installation match GitHub's full list: listed repos are
 * upserted (and restored if previously removed); unlisted ones are marked removed.
 */
export async function syncInstallationRepositories(
  db: Database,
  installationId: number,
  repos: RepositoryInput[],
): Promise<{ upserted: number; removed: number }> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const upserted = await upsertRepositoryRows(tx, installationId, repos, now);
    const listedIds = repos.map((repo) => repo.id);
    const removed = await tx
      .update(repositories)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(
          eq(repositories.installationId, installationId),
          isNull(repositories.removedAt),
          listedIds.length > 0 ? notInArray(repositories.id, listedIds) : undefined,
        ),
      )
      .returning({ id: repositories.id });
    return { upserted, removed: removed.length };
  });
}

/** Webhook delta: `installation_repositories.added`. */
export async function addInstallationRepositories(
  db: Database,
  installationId: number,
  repos: RepositoryInput[],
): Promise<number> {
  return upsertRepositoryRows(db, installationId, repos, new Date());
}

/** Webhook delta: `installation_repositories.removed`. Rows are kept but become invisible. */
export async function removeInstallationRepositories(
  db: Database,
  installationId: number,
  repositoryIds: number[],
): Promise<number> {
  if (repositoryIds.length === 0) return 0;
  const now = new Date();
  const rows = await db
    .update(repositories)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(repositories.installationId, installationId),
        inArray(repositories.id, repositoryIds),
        isNull(repositories.removedAt),
      ),
    )
    .returning({ id: repositories.id });
  return rows.length;
}

export async function listRepositoriesForUser(
  db: Database,
  userId: string,
): Promise<RepositoryWithInstallation[]> {
  const rows = await db
    .select({ repository: repositories, installation: githubInstallations })
    .from(repositories)
    .innerJoin(userInstallations, eq(userInstallations.installationId, repositories.installationId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(userCanAccessRepository(userId))
    .orderBy(repositories.fullName);
  return rows.map(({ repository, installation }) => ({ ...repository, installation }));
}

export async function getRepositoryForUser(
  db: Database,
  userId: string,
  repositoryId: number,
): Promise<RepositoryWithInstallation | null> {
  if (!Number.isSafeInteger(repositoryId)) return null;
  const [row] = await db
    .select({ repository: repositories, installation: githubInstallations })
    .from(repositories)
    .innerJoin(userInstallations, eq(userInstallations.installationId, repositories.installationId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(and(userCanAccessRepository(userId), eq(repositories.id, repositoryId)));
  return row ? { ...row.repository, installation: row.installation } : null;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * Insert or refresh PR metadata (no body). Not user-scoped: call it only with data fetched from
 * GitHub or a verified webhook, after any access check. Out-of-order webhooks never overwrite a
 * newer `githubUpdatedAt`.
 */
export async function upsertPullRequest(
  db: Database,
  repositoryId: number,
  pr: PullRequestInput,
): Promise<PullRequestRow> {
  const now = new Date();
  const fields = {
    title: pr.title,
    authorLogin: pr.authorLogin,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    state: pr.state,
    githubUpdatedAt: pr.githubUpdatedAt,
    updatedAt: now,
  };
  const [row] = await db
    .insert(pullRequests)
    .values({ repositoryId, number: pr.number, ...fields })
    .onConflictDoUpdate({
      target: [pullRequests.repositoryId, pullRequests.number],
      set: fields,
      setWhere: sql`excluded.github_updated_at >= ${pullRequests.githubUpdatedAt}`,
    })
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.number, pr.number)));
  return existing!;
}

export async function listPullRequestsForUser(
  db: Database,
  userId: string,
  repositoryId: number,
  options: { state?: PullRequestState } = {},
): Promise<PullRequestWithLatestAnalysis[]> {
  if (!Number.isSafeInteger(repositoryId)) return [];
  const rows = await db
    .select({ pullRequest: pullRequests })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .innerJoin(userInstallations, eq(userInstallations.installationId, repositories.installationId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(
      and(
        userCanAccessRepository(userId),
        eq(pullRequests.repositoryId, repositoryId),
        options.state ? eq(pullRequests.state, options.state) : undefined,
      ),
    )
    .orderBy(desc(pullRequests.githubUpdatedAt), desc(pullRequests.number));
  if (rows.length === 0) return [];

  const analyses = await db
    .select({
      pullRequestId: prAnalyses.pullRequestId,
      id: prAnalyses.id,
      status: prAnalyses.status,
      analyzerVersion: prAnalyses.analyzerVersion,
      headSha: prAnalyses.headSha,
      errorCode: prAnalyses.errorCode,
      estimatedTokens: prAnalyses.estimatedTokens,
      createdAt: prAnalyses.createdAt,
      updatedAt: prAnalyses.updatedAt,
    })
    .from(prAnalyses)
    .innerJoin(pullRequests, eq(pullRequests.id, prAnalyses.pullRequestId))
    .where(
      and(
        inArray(
          prAnalyses.pullRequestId,
          rows.map((row) => row.pullRequest.id),
        ),
        eq(prAnalyses.headSha, pullRequests.headSha),
      ),
    )
    .orderBy(desc(prAnalyses.createdAt));

  const latest = new Map<string, AnalysisSummary>();
  for (const { pullRequestId, ...summary } of analyses) {
    if (!latest.has(pullRequestId)) latest.set(pullRequestId, summary);
  }
  return rows.map(({ pullRequest }) => ({
    ...pullRequest,
    latestAnalysis: latest.get(pullRequest.id) ?? null,
  }));
}

export async function getPullRequestForUser(
  db: Database,
  userId: string,
  pullRequestId: string,
): Promise<PullRequestAccess | null> {
  if (!isUuid(pullRequestId)) return null;
  const [row] = await db
    .select({
      pullRequest: pullRequests,
      repository: repositories,
      installation: githubInstallations,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .innerJoin(userInstallations, eq(userInstallations.installationId, repositories.installationId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(and(userCanAccessRepository(userId), eq(pullRequests.id, pullRequestId)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

/**
 * Idempotently create the analysis for the PR's current head SHA and analyzer version. Concurrent
 * calls converge on one row via the unique constraint. Callers refresh PR metadata first.
 */
export async function requestAnalysis(
  db: Database,
  input: { userId: string; pullRequestId: string; analyzerVersion: string },
): Promise<RequestAnalysisResult> {
  const access = await getPullRequestForUser(db, input.userId, input.pullRequestId);
  if (!access) return { status: "not_found" };
  if (access.installation.suspendedAt) return { status: "installation_suspended" };

  const { pullRequest } = access;
  const key = {
    repositoryId: pullRequest.repositoryId,
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    analyzerVersion: input.analyzerVersion,
  };
  const [created] = await db
    .insert(prAnalyses)
    .values({ ...key, pullRequestId: pullRequest.id })
    .onConflictDoNothing({
      target: [
        prAnalyses.repositoryId,
        prAnalyses.prNumber,
        prAnalyses.headSha,
        prAnalyses.analyzerVersion,
      ],
    })
    .returning();
  if (created) return { status: "created", analysis: created };

  const [existing] = await db
    .select()
    .from(prAnalyses)
    .where(
      and(
        eq(prAnalyses.repositoryId, key.repositoryId),
        eq(prAnalyses.prNumber, key.prNumber),
        eq(prAnalyses.headSha, key.headSha),
        eq(prAnalyses.analyzerVersion, key.analyzerVersion),
      ),
    );
  if (!existing) return { status: "not_found" };
  return { status: "existing", analysis: existing };
}

export async function getAnalysisForUser(
  db: Database,
  userId: string,
  analysisId: string,
): Promise<AnalysisAccess | null> {
  if (!isUuid(analysisId)) return null;
  const [row] = await db
    .select({
      analysis: prAnalyses,
      pullRequest: pullRequests,
      repository: repositories,
      installation: githubInstallations,
    })
    .from(prAnalyses)
    .innerJoin(pullRequests, eq(pullRequests.id, prAnalyses.pullRequestId))
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .innerJoin(userInstallations, eq(userInstallations.installationId, repositories.installationId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(and(userCanAccessRepository(userId), eq(prAnalyses.id, analysisId)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Worker-side analysis access. NOT user-scoped: only the job worker may call these, with an
// analysis ID taken from a job it enqueued after an access check.
// ---------------------------------------------------------------------------

/** Worker only (not user-scoped). Includes removed repos and deleted installations so the worker can skip. */
export async function getAnalysisForWorker(
  db: Database,
  analysisId: string,
): Promise<AnalysisAccess | null> {
  if (!isUuid(analysisId)) return null;
  const [row] = await db
    .select({
      analysis: prAnalyses,
      pullRequest: pullRequests,
      repository: repositories,
      installation: githubInstallations,
    })
    .from(prAnalyses)
    .innerJoin(pullRequests, eq(pullRequests.id, prAnalyses.pullRequestId))
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .innerJoin(githubInstallations, eq(githubInstallations.id, repositories.installationId))
    .where(eq(prAnalyses.id, analysisId));
  return row ?? null;
}

async function transitionAnalysis(
  db: Database,
  analysisId: string,
  from: AnalysisStatus[],
  set: Partial<typeof prAnalyses.$inferInsert>,
): Promise<boolean> {
  if (!isUuid(analysisId)) return false;
  const rows = await db
    .update(prAnalyses)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(prAnalyses.id, analysisId), inArray(prAnalyses.status, from)))
    .returning({ id: prAnalyses.id });
  return rows.length > 0;
}

/**
 * Worker only (not user-scoped). Returns false when the analysis already reached `succeeded` or
 * `skipped`, so a duplicate job can stop early. A `failed` analysis may be retried.
 */
export function markAnalysisRunning(db: Database, analysisId: string): Promise<boolean> {
  return transitionAnalysis(db, analysisId, ["queued", "running", "failed"], {
    status: "running",
    errorCode: null,
    startedAt: new Date(),
    completedAt: null,
  });
}

/** Worker only (not user-scoped). `context` must already be validated and redacted. */
export function markAnalysisSucceeded(
  db: Database,
  analysisId: string,
  result: { context: Record<string, unknown>; estimatedTokens: number },
): Promise<boolean> {
  return transitionAnalysis(db, analysisId, ["queued", "running"], {
    status: "succeeded",
    errorCode: null,
    context: result.context,
    estimatedTokens: result.estimatedTokens,
    completedAt: new Date(),
  });
}

/** Worker only (not user-scoped). Stores a machine-readable code, never an error message. */
export function markAnalysisFailed(
  db: Database,
  analysisId: string,
  errorCode: string,
): Promise<boolean> {
  return transitionAnalysis(db, analysisId, ["queued", "running"], {
    status: "failed",
    errorCode: assertErrorCode(errorCode),
    completedAt: new Date(),
  });
}

/** Worker only (not user-scoped). E.g. `pull_request_closed`, `head_sha_changed`. */
export function markAnalysisSkipped(
  db: Database,
  analysisId: string,
  reasonCode: string,
): Promise<boolean> {
  return transitionAnalysis(db, analysisId, ["queued", "running"], {
    status: "skipped",
    errorCode: assertErrorCode(reasonCode),
    completedAt: new Date(),
  });
}
