import {
  getAnalysisForWorker,
  jobErrorCode,
  markAnalysisFailed,
  markAnalysisRunning,
  markAnalysisSkipped,
  markAnalysisSucceeded,
  upsertPullRequest,
  type Database,
} from "@academy/db";
import {
  ContextBuildError,
  buildAnalysisContext,
  toPullRequestRecord,
  type GitHubAppClient,
} from "@academy/github";
import type { JobHandler, Logger } from "@academy/shared";

export const PR_ANALYSIS_QUEUE = "pr-analysis";

export interface PrAnalysisPayload {
  analysisId: string;
}

export type PrAnalysisGitHub = Pick<
  GitHubAppClient,
  "getPullRequest" | "listPullRequestFiles" | "getFileContent" | "listDirectory"
>;

/** Maps an error to a storable code. Messages are never stored: they can carry repository content. */
export function analysisErrorCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "github_forbidden";
  if (status === 404) return "github_not_found";
  if (status === 429) return "github_rate_limited";
  if (typeof status === "number" && status >= 500) return "github_unavailable";
  return "context_build_failed";
}

/**
 * Builds the analysis context for one pull request head. Safe to run more than once for the
 * same analysis: finished analyses are left alone, and a head that moved is skipped, not analyzed.
 */
export function createPrAnalysisHandler(deps: {
  db: Database;
  app: PrAnalysisGitHub;
  log: Logger;
  /** Called once the context is stored, e.g. to schedule concept mapping. Failures are logged only. */
  onContextReady?: (analysisId: string) => Promise<void>;
}): JobHandler<PrAnalysisPayload> {
  const { db, app, log, onContextReady } = deps;

  return async (payload, { jobId, attempt }) => {
    const access = await getAnalysisForWorker(db, payload.analysisId);
    if (!access) {
      log.warn("analysis not found", { jobId, analysisId: payload.analysisId });
      return;
    }
    const { analysis, pullRequest, repository, installation } = access;
    if (!(await markAnalysisRunning(db, analysis.id))) return; // already succeeded or skipped

    const skip = async (reason: string) => {
      await markAnalysisSkipped(db, analysis.id, reason);
      log.info("analysis skipped", { jobId, analysisId: analysis.id, reason });
    };
    if (installation.deletedAt || repository.removedAt) return skip("access_removed");
    if (installation.suspendedAt) return skip("installation_suspended");

    try {
      const current = await app.getPullRequest(
        installation.id,
        repository.owner,
        repository.name,
        pullRequest.number,
      );
      if (!current) return skip("pull_request_not_found");
      await upsertPullRequest(db, repository.id, toPullRequestRecord(current));
      if (current.state !== "open") return skip("pull_request_closed");
      if (current.headSha !== analysis.headSha) return skip("head_sha_changed");

      const context = await buildAnalysisContext({
        source: app,
        installationId: installation.id,
        owner: repository.owner,
        repo: repository.name,
        pullNumber: pullRequest.number,
        // A force-push between the check above and the file fetch must not mix two heads.
        expectedHeadSha: analysis.headSha,
      });

      await markAnalysisSucceeded(db, analysis.id, {
        context,
        estimatedTokens: context.budget.estimatedTokens,
      });
      log.info("analysis succeeded", {
        jobId,
        attempt,
        analysisId: analysis.id,
        files: context.files.length,
        includedFiles: context.files.filter((file) => file.included).length,
        estimatedTokens: context.budget.estimatedTokens,
      });
    } catch (error) {
      await handleFailure(error);
      return;
    }

    // Outside the try: the analysis already succeeded, so a follow-up failure must not fail it.
    if (onContextReady) {
      await onContextReady(analysis.id).catch((error: unknown) =>
        log.warn("follow-up after analysis failed", {
          jobId,
          analysisId: analysis.id,
          errorCode: jobErrorCode(error),
        }),
      );
    }

    async function handleFailure(error: unknown) {
      if (error instanceof ContextBuildError) {
        if (error.code === "head_sha_mismatch") return skip("head_sha_changed");
        if (error.code === "pull_request_not_found") return skip("pull_request_not_found");
      }
      const code = analysisErrorCode(error);
      await markAnalysisFailed(db, analysis.id, code);
      log.warn("analysis failed", { jobId, attempt, analysisId: analysis.id, errorCode: code });
      throw Object.assign(new Error("analysis failed"), { code }); // the queue decides whether to retry
    }
  };
}
