import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { FILE_STATUSES } from "./context/schema";
import { GitHubApiError, isNotFoundError } from "./errors";
import type {
  DirectoryEntry,
  FileContent,
  InstallationInfo,
  PullRequestDetails,
  PullRequestFile,
  PullRequestFileList,
  PullRequestSummary,
  RepositoryInfo,
} from "./types";

/** GitHub returns at most 3,000 files for a pull request. */
export const MAX_PULL_REQUEST_FILES = 3_000;
/** Cached installation tokens are replaced this long before GitHub's expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_OPEN_PULL_REQUESTS = 1_000;
const MAX_CACHED_TOKENS = 10_000;

export interface GitHubAppOptions {
  appId: number | string;
  /** PEM. Literal `\n` sequences (common in env vars) are converted to newlines. */
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  baseUrl?: string;
}

export interface GitHubAppClient {
  /** Octokit authenticated as the installation. Tokens are minted on demand and cached in memory. */
  installationClient(installationId: number): Octokit;
  getInstallation(installationId: number): Promise<InstallationInfo | null>;
  listInstallationRepositories(installationId: number): Promise<RepositoryInfo[]>;
  listOpenPullRequests(
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<PullRequestSummary[]>;
  getPullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDetails | null>;
  listPullRequestFiles(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestFileList>;
  /** `null` for missing, non-file, binary (NUL bytes or invalid UTF-8), or oversize content. */
  getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    options: { maxBytes: number },
  ): Promise<FileContent | null>;
  /** `null` when the path is missing or not a directory. */
  listDirectory(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<DirectoryEntry[] | null>;
}

const userRefSchema = z.object({ login: z.string() });

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  owner: userRefSchema,
  default_branch: z.string(),
  private: z.boolean(),
  archived: z.boolean().optional(),
});

const pullRequestSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  user: userRefSchema.nullable(),
  html_url: z.string(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  updated_at: z.string(),
});

const pullRequestDetailsSchema = pullRequestSummarySchema.extend({
  body: z.string().nullable(),
  merged: z.boolean().nullish(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  base: z.object({ ref: z.string(), sha: z.string(), repo: repositorySchema }),
});

const pullRequestFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().nullish(),
  status: z.enum(FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().nullish(),
});

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z
    .union([z.object({ login: z.string(), type: z.string() }), z.object({ slug: z.string() })])
    .nullable(),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().nullish(),
});

const fileContentSchema = z.object({
  type: z.literal("file"),
  size: z.number().int().nonnegative(),
  encoding: z.string(),
  content: z.string(),
});

const directorySchema = z.array(
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir", "symlink", "submodule"]),
  }),
);

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new GitHubApiError("unexpected_response");
  return parsed.data;
}

function toRepository(data: z.infer<typeof repositorySchema>): RepositoryInfo {
  return {
    id: data.id,
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    archived: data.archived ?? false,
  };
}

function toPullRequestSummary(data: z.infer<typeof pullRequestSummarySchema>): PullRequestSummary {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    draft: data.draft ?? false,
    authorLogin: data.user?.login ?? "ghost",
    htmlUrl: data.html_url,
    baseRef: data.base.ref,
    baseSha: data.base.sha,
    headRef: data.head.ref,
    headSha: data.head.sha,
    updatedAt: data.updated_at,
  };
}

function toPullRequestFile(data: z.infer<typeof pullRequestFileSchema>): PullRequestFile {
  const patch = data.patch ?? undefined;
  return {
    path: data.filename,
    ...(data.previous_filename ? { previousPath: data.previous_filename } : {}),
    status: data.status,
    additions: data.additions,
    deletions: data.deletions,
    changes: data.changes,
    ...(patch !== undefined ? { patch } : {}),
    patchOmitted: patch === undefined && data.changes > 0,
  };
}

/** Decode bytes as UTF-8 text; `null` for binary-looking content. */
export function decodeTextContent(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * In-memory token cache for `@octokit/auth-app` (never persisted). Entries are treated as
 * missing once they are within `TOKEN_REFRESH_MARGIN_MS` of GitHub's `expires_at`, so a fresh
 * token is minted. The value format is auth-app's `token|createdAt|expiresAt|…`.
 */
export function createInstallationTokenCache(now: () => Date) {
  const entries = new Map<string, string>();
  return {
    get(key: string): string {
      const value = entries.get(key);
      if (value === undefined) return "";
      const expiresAt = Date.parse(value.split("|")[2] ?? "");
      if (!Number.isFinite(expiresAt) || expiresAt - now().getTime() <= TOKEN_REFRESH_MARGIN_MS) {
        entries.delete(key);
        return "";
      }
      return value;
    },
    set(key: string, value: string): void {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > MAX_CACHED_TOKENS) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}

export function createGitHubApp(options: GitHubAppOptions): GitHubAppClient {
  const privateKey = options.privateKey.replace(/\\n/g, "\n");
  const now = options.now ?? (() => new Date());
  const cache = createInstallationTokenCache(now);
  const shared = {
    authStrategy: createAppAuth,
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    userAgent: "codebase-academy",
  };

  const appClient = new Octokit({
    ...shared,
    auth: { appId: options.appId, privateKey, cache },
  });
  const installationClients = new Map<number, Octokit>();

  const installationClient = (installationId: number): Octokit => {
    let client = installationClients.get(installationId);
    if (!client) {
      client = new Octokit({
        ...shared,
        auth: { appId: options.appId, privateKey, installationId, cache },
      });
      installationClients.set(installationId, client);
    }
    return client;
  };

  const nullOnNotFound = async <T>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  };

  return {
    installationClient,

    getInstallation: (installationId) =>
      nullOnNotFound(async () => {
        const { data } = await appClient.rest.apps.getInstallation({
          installation_id: installationId,
        });
        const installation = parseResponse(installationSchema, data);
        const account = installation.account;
        return {
          id: installation.id,
          accountLogin: account === null ? "" : "login" in account ? account.login : account.slug,
          accountType: account !== null && "type" in account ? account.type : "Enterprise",
          repositorySelection: installation.repository_selection,
          suspendedAt: installation.suspended_at ?? null,
        };
      }),

    async listInstallationRepositories(installationId) {
      const octokit = installationClient(installationId);
      const repositories: RepositoryInfo[] = [];
      for await (const response of octokit.paginate.iterator(
        octokit.rest.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      )) {
        for (const item of response.data as unknown[]) {
          repositories.push(toRepository(parseResponse(repositorySchema, item)));
        }
      }
      return repositories;
    },

    async listOpenPullRequests(installationId, owner, repo) {
      const octokit = installationClient(installationId);
      const pulls: PullRequestSummary[] = [];
      for await (const response of octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      })) {
        for (const item of response.data as unknown[]) {
          pulls.push(toPullRequestSummary(parseResponse(pullRequestSummarySchema, item)));
          if (pulls.length >= MAX_OPEN_PULL_REQUESTS) return pulls;
        }
      }
      return pulls;
    },

    getPullRequest: (installationId, owner, repo, pullNumber) =>
      nullOnNotFound(async () => {
        const { data } = await installationClient(installationId).rest.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
        });
        const pull = parseResponse(pullRequestDetailsSchema, data);
        return {
          ...toPullRequestSummary(pull),
          body: pull.body ?? "",
          merged: pull.merged ?? false,
          additions: pull.additions,
          deletions: pull.deletions,
          changedFiles: pull.changed_files,
          repository: toRepository(pull.base.repo),
        };
      }),

    async listPullRequestFiles(installationId, owner, repo, pullNumber) {
      const octokit = installationClient(installationId);
      const files: PullRequestFile[] = [];
      let truncated = false;
      outer: for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      })) {
        for (const item of response.data as unknown[]) {
          if (files.length >= MAX_PULL_REQUEST_FILES) {
            truncated = true;
            break outer;
          }
          files.push(toPullRequestFile(parseResponse(pullRequestFileSchema, item)));
        }
      }
      if (files.length >= MAX_PULL_REQUEST_FILES) truncated = true;
      return {
        files,
        truncated,
        omittedPatchPaths: files.filter((file) => file.patchOmitted).map((file) => file.path),
      };
    },

    async getFileContent(installationId, owner, repo, path, ref, { maxBytes }) {
      const data = await nullOnNotFound(async () => {
        const response = await installationClient(installationId).rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        return response.data as unknown;
      });
      if (data === null) return null;
      const parsed = fileContentSchema.safeParse(data);
      // Directories, symlinks, submodules, and files over 1 MB (encoding "none") are not text we fetch.
      if (!parsed.success || parsed.data.encoding !== "base64" || parsed.data.size > maxBytes) {
        return null;
      }
      const bytes = Buffer.from(parsed.data.content, "base64");
      if (bytes.length > maxBytes) return null;
      const text = decodeTextContent(bytes);
      return text === null ? null : { text, size: bytes.length };
    },

    async listDirectory(installationId, owner, repo, path, ref) {
      const data = await nullOnNotFound(async () => {
        const response = await installationClient(installationId).rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        return response.data as unknown;
      });
      if (data === null || !Array.isArray(data)) return null;
      return parseResponse(directorySchema, data).map(({ name, path: entryPath, type }) => ({
        name,
        path: entryPath,
        type,
      }));
    },
  };
}
