import {
  linkVerifiedUserInstallation,
  requestAnalysis,
  schema,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import type { PullRequestDetails, PullRequestFile } from "@academy/github";
import { createLogger } from "@academy/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrAnalysisHandler, type PrAnalysisGitHub } from "./pr-analysis";

const log = createLogger({ write: () => {} });
const HEAD = "b".repeat(40);
const repositoryInfo = {
  id: 5001,
  owner: "octo-org",
  name: "payments",
  fullName: "octo-org/payments",
  defaultBranch: "main",
  private: true,
  archived: false,
};

const serviceSource = [
  "import { createClient } from './client';",
  "",
  "const paymentsApi = createClient({ baseUrl: process.env.PAYMENTS_URL });",
  "",
  "export async function charge(payload) {",
  "  return withRetry(() => paymentsApi.post('/charges', payload), { attempts: 4 });",
  "}",
].join("\n");

const files: PullRequestFile[] = [
  {
    path: "src/paymentService.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch:
      '@@ -4,3 +4,4 @@\n \n-export async function charge(payload) {\n+const API_KEY = "sk_live_' +
      "abcdefghijklmnopqrstuvwxyz\";\n+export async function charge(payload) {\n   return withRetry(() => paymentsApi.post('/charges', payload), { attempts: 4 });",
    patchOmitted: false,
  },
  {
    path: "package-lock.json",
    status: "modified",
    additions: 400,
    deletions: 380,
    changes: 780,
    patchOmitted: true,
  },
];

function details(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    number: 8,
    title: "Retry charges",
    state: "open",
    draft: false,
    authorLogin: "dev",
    htmlUrl: "https://github.com/octo-org/payments/pull/8",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "retry",
    headSha: HEAD,
    updatedAt: "2026-09-14T10:00:00Z",
    body: "Adds retries.",
    merged: false,
    additions: 402,
    deletions: 381,
    changedFiles: 2,
    repository: repositoryInfo,
    ...overrides,
  } as PullRequestDetails;
}

function fakeGitHub(
  options: { pr?: PullRequestDetails | null; filesError?: Error } = {},
): PrAnalysisGitHub & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    getPullRequest: async () => (
      calls.push("getPullRequest"),
      options.pr === undefined ? details() : options.pr
    ),
    listPullRequestFiles: async () => {
      calls.push("listPullRequestFiles");
      if (options.filesError) throw options.filesError;
      return { files, truncated: false, omittedPatchPaths: ["package-lock.json"] };
    },
    getFileContent: async (_id: number, _owner: string, _repo: string, path: string) => {
      calls.push(`getFileContent:${path}`);
      return path === "src/paymentService.ts"
        ? { text: serviceSource, size: serviceSource.length }
        : null;
    },
    listDirectory: async () => [],
  } as unknown as PrAnalysisGitHub & { calls: string[] };
}

let handle: DatabaseHandle;
let analysisId: string;

beforeEach(async () => {
  await handle?.close();
  handle = await createTestDatabase();
  const [user] = await handle.db
    .insert(schema.users)
    .values({ name: "Dev", email: "dev@example.test" })
    .returning();
  await upsertInstallation(handle.db, {
    id: 11,
    accountLogin: "octo-org",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId: user!.id, installationId: 11 });
  await syncInstallationRepositories(handle.db, 11, [repositoryInfo]);
  const pr = await upsertPullRequest(handle.db, 5001, {
    number: 8,
    title: "Retry charges",
    authorLogin: "dev",
    baseRef: "main",
    headRef: "retry",
    baseSha: "a".repeat(40),
    headSha: HEAD,
    state: "open",
    githubUpdatedAt: new Date("2026-09-14T09:00:00Z"),
  });
  const result = await requestAnalysis(handle.db, {
    userId: user!.id,
    pullRequestId: pr.id,
    analyzerVersion: "context-v1",
  });
  if (result.status !== "created") throw new Error("analysis not created");
  analysisId = result.analysis.id;
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

const analysisRow = async () => {
  const [row] = await handle.db
    .select()
    .from(schema.prAnalyses)
    .where(eq(schema.prAnalyses.id, analysisId));
  return row!;
};

describe("pr-analysis job handler", () => {
  it("stores a redacted, budgeted context and marks the analysis succeeded", async () => {
    const handler = createPrAnalysisHandler({ db: handle.db, app: fakeGitHub(), log });
    await handler({ analysisId }, { jobId: "job-1", attempt: 1 });

    const row = await analysisRow();
    expect(row.status).toBe("succeeded");
    const context = row.context as {
      files: { path: string; included: boolean; skipReason?: string }[];
      redactions: Record<string, number>;
      budget: { estimatedTokens: number; maxTotalTokens: number };
      pullRequest: { headSha: string };
    };
    expect(context.pullRequest.headSha).toBe(HEAD);
    expect(context.files.find((f) => f.path === "package-lock.json")?.included).toBe(false);
    expect(context.files.find((f) => f.path === "src/paymentService.ts")?.included).toBe(true);
    expect(JSON.stringify(context)).not.toContain("sk_live_" + "abcdefghijklmnopqrstuvwxyz");
    expect(Object.values(context.redactions).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(context.budget.estimatedTokens).toBeLessThanOrEqual(context.budget.maxTotalTokens);
    expect(row.estimatedTokens).toBe(context.budget.estimatedTokens);
  });

  it("does not redo an analysis that already succeeded", async () => {
    await createPrAnalysisHandler({ db: handle.db, app: fakeGitHub(), log })(
      { analysisId },
      { jobId: "j", attempt: 1 },
    );
    const again = fakeGitHub();
    await createPrAnalysisHandler({ db: handle.db, app: again, log })(
      { analysisId },
      { jobId: "j2", attempt: 1 },
    );
    expect(again.calls).toEqual([]);
  });

  it("skips when the head moved or the pull request closed", async () => {
    await createPrAnalysisHandler({
      db: handle.db,
      app: fakeGitHub({
        pr: details({ headSha: "c".repeat(40), updatedAt: "2026-09-14T11:00:00Z" }),
      }),
      log,
    })({ analysisId }, { jobId: "j", attempt: 1 });
    expect(await analysisRow()).toMatchObject({ status: "skipped", errorCode: "head_sha_changed" });
  });

  it("skips a pull request GitHub no longer returns", async () => {
    await createPrAnalysisHandler({ db: handle.db, app: fakeGitHub({ pr: null }), log })(
      { analysisId },
      { jobId: "j", attempt: 1 },
    );
    expect(await analysisRow()).toMatchObject({
      status: "skipped",
      errorCode: "pull_request_not_found",
    });
  });

  it("fails with a code (never a message) and rethrows so the queue can retry", async () => {
    const handler = createPrAnalysisHandler({
      db: handle.db,
      app: fakeGitHub({
        filesError: Object.assign(new Error("secret-bearing message"), { status: 503 }),
      }),
      log,
    });
    await expect(handler({ analysisId }, { jobId: "j", attempt: 1 })).rejects.toMatchObject({
      code: "github_unavailable",
    });
    const row = await analysisRow();
    expect(row).toMatchObject({ status: "failed", errorCode: "github_unavailable" });
    expect(JSON.stringify(row)).not.toContain("secret-bearing");

    // A retry of the failed analysis runs again and can succeed.
    await createPrAnalysisHandler({ db: handle.db, app: fakeGitHub(), log })(
      { analysisId },
      { jobId: "j", attempt: 2 },
    );
    expect((await analysisRow()).status).toBe("succeeded");
  });
});
