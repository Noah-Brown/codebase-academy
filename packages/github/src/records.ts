import { GitHubApiError } from "./errors";
import type {
  InstallationInfo,
  PullRequestDetails,
  PullRequestSummary,
  RepositoryInfo,
} from "./types";
import type {
  InstallationWebhookEvent,
  PullRequestWebhookEvent,
  WebhookRepositoryRef,
} from "./webhooks";

/**
 * Mappers from app-client and webhook objects to the input shapes of the `@academy/db` upserts.
 * They carry metadata only (never PR bodies or patches). This package does not import the db.
 */

export type WebhookPullRequest = PullRequestWebhookEvent["pull_request"];
export type WebhookPullRequestRepository = PullRequestWebhookEvent["repository"];
export type WebhookInstallation = InstallationWebhookEvent["installation"];

export interface PullRequestRecord {
  number: number;
  title: string;
  authorLogin: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  githubUpdatedAt: Date;
}

export interface InstallationRecord {
  id: number;
  accountLogin: string;
  accountType: string;
  suspendedAt: Date | null;
}

export interface RepositoryRecord {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  /** Absent when the source does not carry it (installation webhook repository refs). */
  defaultBranch?: string | null;
  private: boolean;
}

function toDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GitHubApiError("invalid_timestamp");
  return date;
}

function pullRequestState(state: "open" | "closed", merged: boolean): PullRequestRecord["state"] {
  return state === "closed" && merged ? "merged" : state;
}

/**
 * `merged` defaults to the source's own flag (`false` for a `PullRequestSummary`, which has none).
 */
export function toPullRequestRecord(
  pr: PullRequestDetails | PullRequestSummary | WebhookPullRequest,
  options: { merged?: boolean } = {},
): PullRequestRecord {
  if ("user" in pr) {
    return {
      number: pr.number,
      title: pr.title,
      authorLogin: pr.user.login,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      state: pullRequestState(pr.state, options.merged ?? pr.merged ?? false),
      githubUpdatedAt: toDate(pr.updated_at),
    };
  }
  const merged = options.merged ?? ("merged" in pr ? pr.merged : false);
  return {
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    state: pullRequestState(pr.state, merged),
    githubUpdatedAt: toDate(pr.updatedAt),
  };
}

export function toInstallationRecord(
  installation: WebhookInstallation | InstallationInfo,
): InstallationRecord {
  if ("account" in installation) {
    return {
      id: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      suspendedAt: installation.suspended_at ? toDate(installation.suspended_at) : null,
    };
  }
  return {
    id: installation.id,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    suspendedAt: installation.suspendedAt ? toDate(installation.suspendedAt) : null,
  };
}

export function toRepositoryRecord(
  repository: RepositoryInfo | WebhookRepositoryRef | WebhookPullRequestRepository,
): RepositoryRecord {
  if ("fullName" in repository) {
    return {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      private: repository.private,
    };
  }
  const owner = "owner" in repository ? repository.owner.login : repository.full_name.split("/")[0];
  if (!owner || !repository.full_name.includes("/")) {
    throw new GitHubApiError("invalid_repository_full_name");
  }
  return {
    id: repository.id,
    owner,
    name: repository.name,
    fullName: repository.full_name,
    ...("default_branch" in repository ? { defaultBranch: repository.default_branch } : {}),
    private: repository.private,
  };
}
