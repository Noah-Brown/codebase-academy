import type { FileStatus } from "./context/schema";

/** Normalized GitHub objects returned by the app client. Raw Octokit responses never leave it. */

export interface InstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

export interface RepositoryInfo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  authorLogin: string;
  htmlUrl: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  updatedAt: string;
}

export interface PullRequestDetails extends PullRequestSummary {
  /** Unredacted; only the context builder may store it (after redaction). Never log it. */
  body: string;
  merged: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The base repository. */
  repository: RepositoryInfo;
}

export interface PullRequestFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  /** GitHub reported changed lines but returned no patch (the diff was too large to include). */
  patchOmitted: boolean;
}

export interface PullRequestFileList {
  files: PullRequestFile[];
  /** GitHub's 3,000-file limit was reached, so the list may be incomplete. */
  truncated: boolean;
  omittedPatchPaths: string[];
}

export interface FileContent {
  text: string;
  size: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
}
