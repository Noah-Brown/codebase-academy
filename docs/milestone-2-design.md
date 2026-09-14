# Milestone 2 design: GitHub ingestion

**Exit criterion (brief §21):** a real pull request becomes a normalized, safely budgeted analysis context.

This document is the contract that the parallel work streams build against. Sections marked **Contract**
are interfaces other streams depend on, so change them here first.

## Scope

In scope:

1. Sign-in with GitHub (Better Auth, D19) and a starting-level onboarding step that calls `initializeLearner`.
2. GitHub App installations: install callback, webhook with signature verification, and installation/repository sync.
3. Short-lived installation tokens, minted on demand and never persisted.
4. Listing a user's connected repositories and their open pull requests.
5. `pr_analyses`, idempotent per `(repository, PR number, head SHA, analyzer version)`, run by a durable job queue.
6. A context builder: patches, bounded surrounding lines, manifests, token budgets, skip lists, secret redaction.
7. Tenant scoping on every repository-derived lookup, with tests.

Out of scope (later milestones): concept mapping and any model call (M3), lessons (M4), data deletion UX (M5).
There are no PR comments, checks, or merge gates, ever (brief §24).

## Trust and tenancy rules

- **Identity** comes from the Better Auth session. **Authority over an installation** comes only from GitHub:
  a user may link an installation only if `GET /user/installations` (called with that user's GitHub token)
  lists it. The `installation_id` query parameter on the install callback is untrusted.
- Every table holding repository-derived data carries `user_id`, or reaches it through an enforced
  foreign-key path (`pr_analyses → pull_requests → repositories → user_installations`).
- Repository functions that read repository-derived data **require** a `userId` argument and filter by it.
  A lookup for another user's row returns `null` (never a 403 that confirms existence).
- Webhooks are trusted only after HMAC-SHA256 verification of the raw body (constant-time compare).
  Unverified requests get `401` and no processing.
- Raw patches, file contents, and PR bodies are never logged. The context builder redacts likely secrets
  before anything is stored.
- GitHub App permissions stay read-only: metadata, contents, and pull requests; email addresses (account).

## Data model (Contract)

Better Auth tables (`user`, `session`, `account`, `verification`) are mapped onto our schema. `users` keeps
`starting_level`. Its `email_verified` column becomes a boolean, which Better Auth requires.

New tables:

| Table                  | Key columns                                                                                                                                                                                                                                           | Notes                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `github_installations` | `id` (GitHub installation ID, bigint PK), `account_login`, `account_type`, `suspended_at`, `deleted_at`                                                                                                                                               | Global per installation.                                               |
| `user_installations`   | PK `(user_id, installation_id)`, `verified_at`                                                                                                                                                                                                        | Links a user to an installation after the `/user/installations` check. |
| `repositories`         | `id` (GitHub repo ID, bigint PK), `installation_id`, `owner`, `name`, `full_name`, `default_branch`, `private`, `removed_at`                                                                                                                          | Synced from the installation.                                          |
| `pull_requests`        | `id` uuid PK, unique `(repository_id, number)`, `title`, `author_login`, `base_ref`, `head_ref`, `base_sha`, `head_sha`, `state`, `github_updated_at`                                                                                                 | Metadata only; the body is kept in the analysis context, redacted.     |
| `pr_analyses`          | `id` uuid PK, unique `(repository_id, pr_number, head_sha, analyzer_version)`, `pull_request_id`, `status` (`queued`, `running`, `succeeded`, `failed`, `skipped`), `error_code`, `context` jsonb (`AnalysisContext`), `estimated_tokens`, timestamps | Idempotency key is the unique constraint.                              |
| `jobs`                 | `id` uuid PK, `queue`, `payload` jsonb, unique `idempotency_key`, `status` (`queued`, `running`, `succeeded`, `failed`), `attempts`, `max_attempts`, `run_after`, `locked_until`, `last_error_code`, timestamps                                       | Durable queue (D20).                                                   |

Access for a user to a repository means a non-deleted `user_installations` row for that repository's
installation, and a repository that has not been removed.

## Job queue (Contract, D20)

A small Postgres queue in `@academy/db` implementing the existing `JobQueue` interface from `@academy/shared`:

- `enqueue(name, payload, { idempotencyKey })` inserts with `ON CONFLICT (idempotency_key) DO NOTHING` and
  returns the existing job's ID on conflict.
- Workers claim with `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. They
  set `status = running` and `locked_until = now() + lease`.
- Success marks `succeeded`. Failure increments `attempts` and either reschedules with exponential backoff
  or marks `failed` after `max_attempts`. Error codes are stored; messages are not, because they may carry content.
- Jobs whose lease expires (`running` and `locked_until < now()`) are claimable again.

Chosen over pg-boss because it runs unchanged against PGlite in tests. Every behavior above is covered by
tests, including two workers racing for one job.

## `@academy/github` (Contract)

No database access. Everything that talks to GitHub goes through an injected `fetch`, so tests never hit the network.

- `createGitHubApp({ appId, privateKey, fetch?, now? })`
  - `installationClient(installationId)` mints an installation token via `@octokit/auth-app`. It is cached
    in memory only, refreshed 5 minutes before expiry, and never persisted.
  - `getInstallation(id)`, `listInstallationRepositories(id)` (paginated).
  - `listOpenPullRequests(id, owner, repo)`, `getPullRequest(id, owner, repo, number)`.
  - `listPullRequestFiles(id, owner, repo, number)`: paginated, capped at GitHub's 3,000-file limit. It
    reports files whose `patch` GitHub omitted.
  - `getFileContent(id, owner, repo, path, ref, { maxBytes })`: returns `null` for binary or oversize content.
- `listUserInstallations(userAccessToken, fetch?)`: the only source of truth for user → installation authority.
- `verifyWebhookSignature(secret, rawBody, signatureHeader)`: constant-time; `false` on any malformed input.
- `parseWebhookEvent(eventName, payload)`: a Zod-validated union for `installation`,
  `installation_repositories`, and `pull_request` (`opened`, `reopened`, `synchronize`, `edited`, `closed`).
  Returns `{ kind: "ignored" }` for anything else.
- `buildAnalysisContext({ source, installationId, owner, repo, pullNumber, config })`: `source` is a narrow
  interface (a subset of the app client), so tests pass a fake. Returns `AnalysisContext`.
- `toPullRequestRecord`, `toInstallationRecord`, `toRepositoryRecord`: map app-client or webhook objects to the
  input shapes of the `@academy/db` upserts (`state` is `merged` for a closed, merged PR; timestamps become `Date`).

### Context builder rules

- **Skip before fetching:**
  - lockfiles
  - generated or minified files (`dist/`, `build/`, `*.min.*`, `*.map`, `__generated__/`, snapshots)
  - vendored code (`vendor/`, `node_modules/`, `third_party/`)
  - binaries (by extension, or a missing patch on a non-text file); an empty text file (no patch, no
    changes) is recorded as `empty`
  - files over the size cap
- **Changed files:** keep the patch. For modified files, fetch head content and include ±`contextRadius`
  lines around each hunk, with overlapping windows merged.
- **Manifests** (`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`,
  `pom.xml`, `build.gradle*`) are included as truncated excerpts when present at the head.
- **Redaction** runs on every patch, context window, manifest excerpt, and PR body before budgeting. It
  covers private-key blocks, cloud and provider keys (AWS, GitHub, Slack, Stripe, Anthropic, OpenAI),
  JWTs, and `key|secret|token|password = "<value>"` assignments, plus unquoted literal values (8+ characters) for sensitive names in YAML (`password: …`) and
  dotenv (`SECRET_KEY = …`) lines. Placeholders look like
  `[REDACTED:kind]`, and the counts per kind are recorded. Type declarations such as `password: string`
  are not redacted.
- **Budget:** `estimateTokens(text) = ceil(chars / 4)` (documented approximation; the model tokenizer comes in M3).
  - Defaults: `maxTotalTokens` 24,000; `maxFileTokens` 4,000; `contextRadius` 20; `maxFiles` 60.
  - Files are prioritized by source over tests over docs and config, then by change size. Deterministic ties break by path.
  - Over-budget files are truncated at hunk boundaries. When the first hunk alone does not fit, it is cut at a
    line boundary: the hunk header is rewritten to the kept line counts and a `\ … truncated N lines (budget)`
    marker line is appended. A file is omitted (reason `budget`) only when not even the header plus 20 lines fits.
    Truncated paths are listed in `budget.truncatedFiles`.
- The PR body is redacted and truncated to 2,000 characters.
- The output is validated with a Zod schema before it is returned.

### `AnalysisContext` shape (Contract)

```ts
type AnalysisContext = {
  analyzerVersion: string; // "context-v1"
  repository: { id: number; fullName: string; defaultBranch: string };
  pullRequest: {
    number: number;
    title: string;
    body: string;
    author: string;
    url: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
  };
  languages: Record<string, number>; // file extension → changed-file count
  files: Array<{
    path: string;
    previousPath?: string;
    status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
    additions: number;
    deletions: number;
    included: boolean;
    skipReason?:
      | "lockfile"
      | "generated"
      | "vendored"
      | "binary"
      | "too_large"
      | "no_patch"
      | "empty"
      | "budget";
    patch?: string;
    patchTruncated: boolean;
    // Ranges of the hunks in `patch`; a hunk cut by the budget describes only the lines kept.
    hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }>;
    context: Array<{ startLine: number; endLine: number; text: string }>;
    estimatedTokens: number;
  }>;
  manifests: Array<{ path: string; excerpt: string }>;
  redactions: Record<string, number>;
  budget: {
    maxTotalTokens: number;
    estimatedTokens: number;
    truncatedFiles: string[];
    omittedFiles: string[];
  };
  warnings: string[]; // e.g. "github_file_list_truncated", "patch_omitted:<path>"
};
```

## Web and worker

- **Auth:** Better Auth at `/api/auth/*` with the GitHub provider, using the GitHub App's OAuth client. It
  stores the user's GitHub access and refresh tokens in `account`, which are needed only for `/user/installations`.
- **Onboarding:** `/onboarding` asks for a starting level, then calls `initializeLearner`.
- **Install:** "Connect GitHub" goes to `https://github.com/apps/<slug>/installations/new`. The callback
  `/api/github/install/callback` re-verifies ownership via `/user/installations`, then syncs the
  installation and its repositories.
- **Webhook:** `/api/github/webhook` verifies the signature, then handles:
  - installation created or deleted, suspended or unsuspended
  - repositories added or removed
  - pull requests opened, updated, or closed: upserts PR metadata only. Analysis is manual in the MVP.
- **Pages:** `/repositories` (connected repos), `/repositories/[repoId]` (open PRs with analysis status),
  `/analyses/[analysisId]` (context summary: included and skipped files, budget, redaction counts; no code dump).
- **Analyze:** `POST /api/pull-requests/[prId]/analyze` checks access, refreshes PR metadata, upserts the
  `pr_analyses` row for the head SHA, enqueues `pr-analysis:{repoId}:{number}:{headSha}:{analyzerVersion}`,
  and returns the analysis ID. Repeat calls return the same analysis.
- **Worker:** claims `pr-analysis` jobs and builds the context, then stores it and marks the analysis
  `succeeded`. On a PR that has since closed or force-pushed, it marks the analysis `skipped` with a reason.

## Environment (M2)

`AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `APP_BASE_URL`, `DATABASE_URL`. Everything is
validated with Zod at startup. The web app without GitHub configuration still boots and explains what is missing.
