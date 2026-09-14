import {
  failJob,
  linkVerifiedUserInstallation,
  markAnalysisFailed,
  markAnalysisRunning,
  schema,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import type { PullRequestDetails } from "@academy/github";
import { createLogger } from "@academy/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PR_ANALYSIS_QUEUE, startAnalysis } from "./start-analysis";

const log = createLogger({ write: () => {} });
let handle: DatabaseHandle;
let owner: string;
let stranger: string;
let prId: string;

const HEAD = "b".repeat(40);
const repositoryInfo = {
  id: 9001,
  owner: "octo-org",
  name: "api",
  fullName: "octo-org/api",
  defaultBranch: "main",
  private: true,
  archived: false,
};

function details(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    number: 3,
    title: "Retry payments",
    state: "open",
    draft: false,
    authorLogin: "dev",
    htmlUrl: "https://github.com/octo-org/api/pull/3",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "retry",
    headSha: HEAD,
    updatedAt: "2026-09-14T10:00:00Z",
    body: "",
    merged: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    repository: repositoryInfo,
    ...overrides,
  } as PullRequestDetails;
}

const fakeApp = (pr: PullRequestDetails | null | Error) => ({
  getPullRequest: async () => {
    if (pr instanceof Error) throw pr;
    return pr;
  },
});

const jobs = () =>
  handle.db.select().from(schema.jobs).where(eq(schema.jobs.queue, PR_ANALYSIS_QUEUE));

beforeAll(async () => {
  handle = await createTestDatabase();
  const users = await handle.db
    .insert(schema.users)
    .values([
      { name: "Owner", email: "owner@example.test" },
      { name: "Stranger", email: "stranger@example.test" },
    ])
    .returning();
  owner = users[0]!.id;
  stranger = users[1]!.id;
  await upsertInstallation(handle.db, {
    id: 77,
    accountLogin: "octo-org",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId: owner, installationId: 77 });
  await syncInstallationRepositories(handle.db, 77, [repositoryInfo]);
  const pr = await upsertPullRequest(handle.db, 9001, {
    number: 3,
    title: "Retry payments",
    authorLogin: "dev",
    baseRef: "main",
    headRef: "retry",
    baseSha: "a".repeat(40),
    headSha: HEAD,
    state: "open",
    githubUpdatedAt: new Date("2026-09-14T09:00:00Z"),
  });
  prId = pr.id;
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe("startAnalysis", () => {
  it("returns not_found to users without access, without calling GitHub", async () => {
    let called = false;
    const result = await startAnalysis(
      handle.db,
      { getPullRequest: async () => ((called = true), details()) },
      stranger,
      prId,
      log,
    );
    expect(result).toEqual({ status: 404, body: { error: "not_found" } });
    expect(called).toBe(false);
  });

  it("creates one analysis and one job for repeated requests on the same head", async () => {
    const first = await startAnalysis(handle.db, fakeApp(details()), owner, prId, log);
    const second = await startAnalysis(handle.db, fakeApp(details()), owner, prId, log);
    expect(first.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(await jobs()).toHaveLength(1);
  });

  it("enqueues a retry job for a failed analysis, once per failure", async () => {
    const started = await startAnalysis(handle.db, fakeApp(details()), owner, prId, log);
    const analysisId = (started.body as { analysisId: string }).analysisId;
    const [job] = await jobs();
    await failJob(handle.db, job!.id, { errorCode: "github_unavailable" });
    await markAnalysisRunning(handle.db, analysisId);
    await markAnalysisFailed(handle.db, analysisId, "github_unavailable");

    await startAnalysis(handle.db, fakeApp(details()), owner, prId, log);
    await startAnalysis(handle.db, fakeApp(details()), owner, prId, log);
    expect(await jobs()).toHaveLength(2);
  });

  it("keys a new analysis on a new head commit", async () => {
    const moved = await startAnalysis(
      handle.db,
      fakeApp(details({ headSha: "c".repeat(40), updatedAt: "2026-09-14T11:00:00Z" })),
      owner,
      prId,
      log,
    );
    expect(moved.status).toBe(202);
    expect(await handle.db.select().from(schema.prAnalyses)).toHaveLength(2);
  });

  it("refuses closed or deleted pull requests and reports GitHub outages", async () => {
    expect(
      (
        await startAnalysis(
          handle.db,
          fakeApp(details({ state: "closed", updatedAt: "2026-09-14T12:00:00Z" })),
          owner,
          prId,
          log,
        )
      ).body,
    ).toEqual({ error: "pull_request_closed" });
    expect((await startAnalysis(handle.db, fakeApp(null), owner, prId, log)).status).toBe(404);
    expect(
      (
        await startAnalysis(
          handle.db,
          fakeApp(Object.assign(new Error("boom"), { status: 502 })),
          owner,
          prId,
          log,
        )
      ).body,
    ).toEqual({ error: "github_unavailable" });
  });
});
