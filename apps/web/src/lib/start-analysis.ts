import {
  enqueueJob,
  getPullRequestForUser,
  requestAnalysis,
  upsertPullRequest,
  type Database,
} from "@academy/db";
import { ANALYZER_VERSION, toPullRequestRecord, type GitHubAppClient } from "@academy/github";
import type { Logger } from "@academy/shared";

export const PR_ANALYSIS_QUEUE = "pr-analysis";

export type StartAnalysisResult =
  | { status: 202; body: { analysisId: string; status: string } }
  | { status: 404 | 409 | 502; body: { error: string } };

/**
 * Start (or return) the analysis of a pull request's current head commit for this user.
 * Idempotent: repeated calls for the same head SHA return the same analysis and enqueue once.
 */
export async function startAnalysis(
  db: Database,
  app: Pick<GitHubAppClient, "getPullRequest">,
  userId: string,
  pullRequestId: string,
  log: Logger,
): Promise<StartAnalysisResult> {
  const access = await getPullRequestForUser(db, userId, pullRequestId);
  if (!access) return { status: 404, body: { error: "not_found" } };
  const { repository, installation, pullRequest } = access;
  if (installation.suspendedAt) return { status: 409, body: { error: "installation_suspended" } };

  // Refresh from GitHub so the analysis is keyed on the real current head, not stale webhook data.
  try {
    const current = await app.getPullRequest(
      installation.id,
      repository.owner,
      repository.name,
      pullRequest.number,
    );
    if (!current) return { status: 404, body: { error: "not_found" } };
    await upsertPullRequest(db, repository.id, toPullRequestRecord(current));
    if (current.state !== "open") return { status: 409, body: { error: "pull_request_closed" } };
  } catch (error) {
    log.warn("pull request refresh failed", { pullRequestId, error });
    return { status: 502, body: { error: "github_unavailable" } };
  }

  const result = await requestAnalysis(db, {
    userId,
    pullRequestId,
    analyzerVersion: ANALYZER_VERSION,
  });
  if (result.status === "not_found") return { status: 404, body: { error: "not_found" } };
  if (result.status === "installation_suspended") {
    return { status: 409, body: { error: "installation_suspended" } };
  }

  const { analysis } = result;
  const key = `pr-analysis:${analysis.repositoryId}:${analysis.prNumber}:${analysis.headSha}:${analysis.analyzerVersion}`;
  if (result.status === "created") {
    await enqueueJob(db, {
      queue: PR_ANALYSIS_QUEUE,
      payload: { analysisId: analysis.id },
      idempotencyKey: key,
    });
  } else if (analysis.status === "failed") {
    // A retry of a failed analysis gets its own job, keyed on the failure it retries,
    // so double-clicking "Retry" still enqueues once.
    await enqueueJob(db, {
      queue: PR_ANALYSIS_QUEUE,
      payload: { analysisId: analysis.id },
      idempotencyKey: `${key}:retry:${analysis.updatedAt.getTime()}`,
    });
  }
  return { status: 202, body: { analysisId: analysis.id, status: analysis.status } };
}
