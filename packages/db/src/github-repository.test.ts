import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./client";
import {
  addInstallationRepositories,
  getAnalysisForUser,
  getAnalysisForWorker,
  getPullRequestForUser,
  getRepositoryForUser,
  linkVerifiedUserInstallation,
  listPullRequestsForUser,
  listRepositoriesForUser,
  markAnalysisFailed,
  markAnalysisRunning,
  markAnalysisSkipped,
  markAnalysisSucceeded,
  markInstallationDeleted,
  removeInstallationRepositories,
  requestAnalysis,
  setInstallationSuspended,
  syncInstallationRepositories,
  upsertInstallation,
  upsertPullRequest,
  type PullRequestInput,
  type RepositoryInput,
} from "./github-repository";
import { prAnalyses, repositories, users } from "./schema";
import { createTestDatabase } from "./testing";

let handle: DatabaseHandle;
let nextId = 10_000;
const newId = () => nextId++;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function createUser(name: string): Promise<string> {
  const [user] = await handle.db
    .insert(users)
    .values({ name, email: `${crypto.randomUUID()}@example.test` })
    .returning();
  return user!.id;
}

const repo = (id: number, name = `repo-${id}`): RepositoryInput => ({
  id,
  owner: "acme",
  name,
  fullName: `acme/${name}`,
  defaultBranch: "main",
  private: true,
});

const pr = (overrides: Partial<PullRequestInput> = {}): PullRequestInput => ({
  number: 7,
  title: "Add retries",
  authorLogin: "octocat",
  baseRef: "main",
  headRef: "feature/retries",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  state: "open",
  githubUpdatedAt: new Date("2026-09-01T00:00:00Z"),
  ...overrides,
});

interface Fixture {
  alice: string;
  bob: string;
  installationId: number;
  repositoryId: number;
  pullRequestId: string;
}

async function fixture(): Promise<Fixture> {
  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const installationId = newId();
  const repositoryId = newId();
  await upsertInstallation(handle.db, {
    id: installationId,
    accountLogin: "acme",
    accountType: "Organization",
  });
  await linkVerifiedUserInstallation(handle.db, { userId: alice, installationId });
  await syncInstallationRepositories(handle.db, installationId, [repo(repositoryId)]);
  const pullRequest = await upsertPullRequest(handle.db, repositoryId, pr());
  return { alice, bob, installationId, repositoryId, pullRequestId: pullRequest.id };
}

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

describe("tenancy", () => {
  it("shows a linked user their repositories, pull requests, and analyses", async () => {
    const repos = await listRepositoriesForUser(handle.db, f.alice);
    expect(repos.map((r) => r.id)).toEqual([f.repositoryId]);
    expect(repos[0]!.installation.accountLogin).toBe("acme");
    expect(await getRepositoryForUser(handle.db, f.alice, f.repositoryId)).not.toBeNull();
    expect(await listPullRequestsForUser(handle.db, f.alice, f.repositoryId)).toHaveLength(1);
    const access = await getPullRequestForUser(handle.db, f.alice, f.pullRequestId);
    expect(access?.repository.id).toBe(f.repositoryId);
  });

  it("hides another user's repository, pull request, and analysis", async () => {
    const requested = await requestAnalysis(handle.db, {
      userId: f.alice,
      pullRequestId: f.pullRequestId,
      analyzerVersion: "context-v1",
    });
    if (requested.status !== "created") throw new Error("expected created");

    expect(await listRepositoriesForUser(handle.db, f.bob)).toEqual([]);
    expect(await getRepositoryForUser(handle.db, f.bob, f.repositoryId)).toBeNull();
    expect(await listPullRequestsForUser(handle.db, f.bob, f.repositoryId)).toEqual([]);
    expect(await getPullRequestForUser(handle.db, f.bob, f.pullRequestId)).toBeNull();
    expect(await getAnalysisForUser(handle.db, f.bob, requested.analysis.id)).toBeNull();
    expect(
      await requestAnalysis(handle.db, {
        userId: f.bob,
        pullRequestId: f.pullRequestId,
        analyzerVersion: "context-v1",
      }),
    ).toEqual({ status: "not_found" });
    expect(await getAnalysisForUser(handle.db, f.alice, requested.analysis.id)).not.toBeNull();
  });

  it("treats malformed IDs as not found", async () => {
    expect(await getPullRequestForUser(handle.db, f.alice, "not-a-uuid")).toBeNull();
    expect(await getAnalysisForUser(handle.db, f.alice, "1; drop table users")).toBeNull();
    expect(await getRepositoryForUser(handle.db, f.alice, Number.NaN)).toBeNull();
  });

  it("hides a repository removed by sync and restores it when listed again", async () => {
    const otherId = newId();
    await syncInstallationRepositories(handle.db, f.installationId, [
      repo(f.repositoryId),
      repo(otherId),
    ]);
    expect((await listRepositoriesForUser(handle.db, f.alice)).map((r) => r.id).sort()).toEqual(
      [f.repositoryId, otherId].sort(),
    );

    const result = await syncInstallationRepositories(handle.db, f.installationId, [repo(otherId)]);
    expect(result).toEqual({ upserted: 1, removed: 1 });
    expect((await listRepositoriesForUser(handle.db, f.alice)).map((r) => r.id)).toEqual([otherId]);
    expect(await getRepositoryForUser(handle.db, f.alice, f.repositoryId)).toBeNull();
    expect(await getPullRequestForUser(handle.db, f.alice, f.pullRequestId)).toBeNull();
    expect(await listPullRequestsForUser(handle.db, f.alice, f.repositoryId)).toEqual([]);

    await syncInstallationRepositories(handle.db, f.installationId, [repo(f.repositoryId)]);
    expect((await listRepositoriesForUser(handle.db, f.alice)).map((r) => r.id)).toEqual([
      f.repositoryId,
    ]);
  });

  it("applies webhook repository deltas and keeps a known default branch", async () => {
    const addedId = newId();
    await addInstallationRepositories(handle.db, f.installationId, [
      { ...repo(addedId), defaultBranch: undefined },
    ]);
    expect((await getRepositoryForUser(handle.db, f.alice, addedId))?.defaultBranch).toBeNull();

    await addInstallationRepositories(handle.db, f.installationId, [
      { ...repo(f.repositoryId), defaultBranch: undefined },
    ]);
    expect((await getRepositoryForUser(handle.db, f.alice, f.repositoryId))?.defaultBranch).toBe(
      "main",
    );

    expect(await removeInstallationRepositories(handle.db, f.installationId, [addedId])).toBe(1);
    expect(await getRepositoryForUser(handle.db, f.alice, addedId)).toBeNull();
    // Another installation cannot remove this installation's repositories.
    expect(await removeInstallationRepositories(handle.db, newId(), [f.repositoryId])).toBe(0);
  });

  it("hides a deleted installation's repositories until it is restored and re-linked", async () => {
    await markInstallationDeleted(handle.db, f.installationId);
    expect(await listRepositoriesForUser(handle.db, f.alice)).toEqual([]);
    expect(await getPullRequestForUser(handle.db, f.alice, f.pullRequestId)).toBeNull();

    await upsertInstallation(handle.db, {
      id: f.installationId,
      accountLogin: "acme",
      accountType: "Organization",
    });
    await linkVerifiedUserInstallation(handle.db, {
      userId: f.alice,
      installationId: f.installationId,
    });
    expect((await listRepositoriesForUser(handle.db, f.alice)).map((r) => r.id)).toEqual([
      f.repositoryId,
    ]);
  });

  it("gives a second verified user access to the same installation", async () => {
    await linkVerifiedUserInstallation(handle.db, {
      userId: f.bob,
      installationId: f.installationId,
    });
    expect(await getPullRequestForUser(handle.db, f.bob, f.pullRequestId)).not.toBeNull();
  });
});

describe("pull requests", () => {
  it("updates metadata in place and ignores out-of-order updates", async () => {
    const updated = await upsertPullRequest(
      handle.db,
      f.repositoryId,
      pr({ headSha: "c".repeat(40), githubUpdatedAt: new Date("2026-09-02T00:00:00Z") }),
    );
    expect(updated.id).toBe(f.pullRequestId);
    expect(updated.headSha).toBe("c".repeat(40));

    const stale = await upsertPullRequest(
      handle.db,
      f.repositoryId,
      pr({
        title: "Old title",
        headSha: "d".repeat(40),
        githubUpdatedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    );
    expect(stale).toMatchObject({
      id: f.pullRequestId,
      headSha: "c".repeat(40),
      title: "Add retries",
    });
  });

  it("filters by state and reports the latest analysis for the current head only", async () => {
    await upsertPullRequest(handle.db, f.repositoryId, pr({ number: 8, state: "closed" }));
    expect(
      (await listPullRequestsForUser(handle.db, f.alice, f.repositoryId, { state: "open" })).map(
        (p) => p.number,
      ),
    ).toEqual([7]);

    const first = await requestAnalysis(handle.db, {
      userId: f.alice,
      pullRequestId: f.pullRequestId,
      analyzerVersion: "context-v1",
    });
    let [listed] = await listPullRequestsForUser(handle.db, f.alice, f.repositoryId, {
      state: "open",
    });
    expect(first.status === "created" && listed!.latestAnalysis?.id).toBe(
      first.status === "created" && first.analysis.id,
    );
    expect(listed!.latestAnalysis?.status).toBe("queued");

    await upsertPullRequest(
      handle.db,
      f.repositoryId,
      pr({ headSha: "e".repeat(40), githubUpdatedAt: new Date("2026-09-03T00:00:00Z") }),
    );
    [listed] = await listPullRequestsForUser(handle.db, f.alice, f.repositoryId, { state: "open" });
    expect(listed!.latestAnalysis).toBeNull();
  });
});

describe("requestAnalysis", () => {
  const request = (userId: string, pullRequestId: string, analyzerVersion = "context-v1") =>
    requestAnalysis(handle.db, { userId, pullRequestId, analyzerVersion });

  it("returns the existing analysis for the same head SHA", async () => {
    const first = await request(f.alice, f.pullRequestId);
    const second = await request(f.alice, f.pullRequestId);
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status !== "created" || second.status !== "existing") return;
    expect(second.analysis.id).toBe(first.analysis.id);
    expect(first.analysis).toMatchObject({
      repositoryId: f.repositoryId,
      prNumber: 7,
      headSha: "b".repeat(40),
      analyzerVersion: "context-v1",
      status: "queued",
    });
  });

  it("creates exactly one row under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(f.alice, f.pullRequestId)),
    );
    const ids = new Set(results.map((r) => ("analysis" in r ? r.analysis.id : null)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    const rows = await handle.db
      .select()
      .from(prAnalyses)
      .where(eq(prAnalyses.pullRequestId, f.pullRequestId));
    expect(rows).toHaveLength(1);
  });

  it("creates a new analysis for a new head SHA or analyzer version", async () => {
    const first = await request(f.alice, f.pullRequestId);
    await upsertPullRequest(
      handle.db,
      f.repositoryId,
      pr({ headSha: "f".repeat(40), githubUpdatedAt: new Date("2026-09-05T00:00:00Z") }),
    );
    const afterPush = await request(f.alice, f.pullRequestId);
    const newVersion = await request(f.alice, f.pullRequestId, "context-v2");
    expect(afterPush.status).toBe("created");
    expect(newVersion.status).toBe("created");
    if (first.status !== "created" || afterPush.status !== "created") return;
    expect(afterPush.analysis.id).not.toBe(first.analysis.id);
    expect(afterPush.analysis.headSha).toBe("f".repeat(40));
  });

  it("refuses while the installation is suspended", async () => {
    await setInstallationSuspended(handle.db, f.installationId, true);
    expect(await request(f.alice, f.pullRequestId)).toEqual({ status: "installation_suspended" });
    // Suspension is not an access grant: other users still get not_found.
    expect(await request(f.bob, f.pullRequestId)).toEqual({ status: "not_found" });
    await setInstallationSuspended(handle.db, f.installationId, false);
    expect((await request(f.alice, f.pullRequestId)).status).toBe("created");
  });

  it("returns not_found without access", async () => {
    expect(await request(f.bob, f.pullRequestId)).toEqual({ status: "not_found" });
    expect(await request(f.alice, crypto.randomUUID())).toEqual({ status: "not_found" });
    await markInstallationDeleted(handle.db, f.installationId);
    expect(await request(f.alice, f.pullRequestId)).toEqual({ status: "not_found" });
  });
});

describe("worker analysis transitions", () => {
  async function analysisId(): Promise<string> {
    const result = await requestAnalysis(handle.db, {
      userId: f.alice,
      pullRequestId: f.pullRequestId,
      analyzerVersion: "context-v1",
    });
    if (!("analysis" in result)) throw new Error("expected analysis");
    return result.analysis.id;
  }

  it("loads the analysis with its pull request, repository, and installation", async () => {
    const id = await analysisId();
    const loaded = await getAnalysisForWorker(handle.db, id);
    expect(loaded).toMatchObject({
      analysis: { id },
      pullRequest: { id: f.pullRequestId },
      repository: { id: f.repositoryId },
      installation: { id: f.installationId },
    });
  });

  it("stores context on success and refuses to rerun a finished analysis", async () => {
    const id = await analysisId();
    expect(await markAnalysisRunning(handle.db, id)).toBe(true);
    expect(
      await markAnalysisSucceeded(handle.db, id, {
        context: { analyzerVersion: "context-v1" },
        estimatedTokens: 1234,
      }),
    ).toBe(true);
    expect(await markAnalysisRunning(handle.db, id)).toBe(false);
    const loaded = await getAnalysisForUser(handle.db, f.alice, id);
    expect(loaded?.analysis).toMatchObject({
      status: "succeeded",
      estimatedTokens: 1234,
      context: { analyzerVersion: "context-v1" },
      errorCode: null,
    });
    expect(loaded?.analysis.completedAt).toBeInstanceOf(Date);
  });

  it("stores failure and skip reasons as codes only", async () => {
    const id = await analysisId();
    await markAnalysisRunning(handle.db, id);
    expect(() => markAnalysisFailed(handle.db, id, "Error: const secret = 'x'")).toThrow(TypeError);
    expect(await markAnalysisFailed(handle.db, id, "github_rate_limited")).toBe(true);
    expect((await getAnalysisForWorker(handle.db, id))?.analysis).toMatchObject({
      status: "failed",
      errorCode: "github_rate_limited",
    });
    // A failed analysis may be retried, then skipped.
    expect(await markAnalysisRunning(handle.db, id)).toBe(true);
    expect(await markAnalysisSkipped(handle.db, id, "pull_request_closed")).toBe(true);
    expect((await getAnalysisForWorker(handle.db, id))?.analysis).toMatchObject({
      status: "skipped",
      errorCode: "pull_request_closed",
    });
  });

  it("removes analyses when the repository row is deleted", async () => {
    await analysisId();
    await handle.db.delete(repositories).where(eq(repositories.id, f.repositoryId));
    const rows = await handle.db
      .select()
      .from(prAnalyses)
      .where(eq(prAnalyses.pullRequestId, f.pullRequestId));
    expect(rows).toEqual([]);
  });
});
