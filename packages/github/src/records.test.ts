import { describe, expect, it } from "vitest";
import installationCreated from "./__fixtures__/installation.created.json";
import installationRepositoriesAdded from "./__fixtures__/installation_repositories.added.json";
import pullRequestOpened from "./__fixtures__/pull_request.opened.json";
import { toInstallationRecord, toPullRequestRecord, toRepositoryRecord } from "./records";
import type { PullRequestDetails, RepositoryInfo } from "./types";
import { parseWebhookEvent, type PullRequestWebhookEvent } from "./webhooks";

function pullRequestEvent(
  mutate: (payload: typeof pullRequestOpened) => void = () => {},
): PullRequestWebhookEvent {
  const payload = structuredClone(pullRequestOpened);
  mutate(payload);
  const event = parseWebhookEvent("pull_request", payload);
  if (event.kind !== "pull_request") throw new Error(`fixture did not parse: ${event.kind}`);
  return event;
}

const repositoryInfo: RepositoryInfo = {
  id: 555001,
  owner: "octo-org",
  name: "api",
  fullName: "octo-org/api",
  defaultBranch: "main",
  private: true,
  archived: false,
};

const details: PullRequestDetails = {
  number: 7,
  title: "Refactor queue",
  state: "closed",
  draft: false,
  authorLogin: "hubot",
  htmlUrl: "https://github.com/octo-org/api/pull/7",
  baseRef: "main",
  baseSha: "base-sha",
  headRef: "queue",
  headSha: "head-sha",
  updatedAt: "2026-09-02T08:00:00Z",
  body: "not part of the record",
  merged: true,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  repository: repositoryInfo,
};

describe("toPullRequestRecord", () => {
  it("maps a webhook pull request", () => {
    expect(toPullRequestRecord(pullRequestEvent().pull_request)).toEqual({
      number: 42,
      title: "Add retry with backoff to webhook delivery",
      authorLogin: "octocat",
      baseRef: "main",
      headRef: "retry-backoff",
      baseSha: "0a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d",
      headSha: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
      state: "open",
      githubUpdatedAt: new Date("2026-09-01T12:05:00Z"),
    });
  });

  it("distinguishes merged from closed", () => {
    const merged = pullRequestEvent((p) => {
      p.action = "closed";
      p.pull_request.state = "closed";
      p.pull_request.merged = true;
    });
    expect(toPullRequestRecord(merged.pull_request).state).toBe("merged");

    const closed = pullRequestEvent((p) => {
      p.pull_request.state = "closed";
    });
    expect(toPullRequestRecord(closed.pull_request).state).toBe("closed");
    expect(toPullRequestRecord(closed.pull_request, { merged: true }).state).toBe("merged");
    // An open PR is never "merged", whatever the flag says.
    expect(toPullRequestRecord(pullRequestEvent().pull_request, { merged: true }).state).toBe(
      "open",
    );
  });

  it("maps app-client details and summaries without the body", () => {
    const record = toPullRequestRecord(details);
    expect(record).toEqual({
      number: 7,
      title: "Refactor queue",
      authorLogin: "hubot",
      baseRef: "main",
      headRef: "queue",
      baseSha: "base-sha",
      headSha: "head-sha",
      state: "merged",
      githubUpdatedAt: new Date("2026-09-02T08:00:00Z"),
    });
    expect(record).not.toHaveProperty("body");

    const {
      body: _body,
      merged: _merged,
      additions: _a,
      deletions: _d,
      changedFiles: _c,
      repository: _r,
      ...summary
    } = details;
    expect(toPullRequestRecord(summary).state).toBe("closed");
    expect(toPullRequestRecord(summary, { merged: true }).state).toBe("merged");
  });

  it("rejects an invalid timestamp", () => {
    expect(() => toPullRequestRecord({ ...details, updatedAt: "yesterday" })).toThrow(
      "invalid_timestamp",
    );
  });
});

describe("toInstallationRecord", () => {
  it("maps a webhook installation, suspended or not", () => {
    const created = parseWebhookEvent("installation", installationCreated);
    if (created.kind !== "installation") throw new Error("fixture did not parse");
    expect(toInstallationRecord(created.installation)).toEqual({
      id: 12345678,
      accountLogin: "octo-org",
      accountType: "Organization",
      suspendedAt: null,
    });

    const payload = structuredClone(installationCreated);
    payload.action = "suspend";
    (payload.installation as { suspended_at: string | null }).suspended_at = "2026-09-03T10:00:00Z";
    const suspended = parseWebhookEvent("installation", payload);
    if (suspended.kind !== "installation") throw new Error("fixture did not parse");
    expect(toInstallationRecord(suspended.installation).suspendedAt).toEqual(
      new Date("2026-09-03T10:00:00Z"),
    );

    const repositories = parseWebhookEvent(
      "installation_repositories",
      installationRepositoriesAdded,
    );
    if (repositories.kind !== "installation_repositories") throw new Error("fixture did not parse");
    expect(toInstallationRecord(repositories.installation).suspendedAt).toBeNull();
  });

  it("maps app-client installation info", () => {
    expect(
      toInstallationRecord({
        id: 9,
        accountLogin: "octocat",
        accountType: "User",
        repositorySelection: "all",
        suspendedAt: "2026-09-04T00:00:00Z",
      }),
    ).toEqual({
      id: 9,
      accountLogin: "octocat",
      accountType: "User",
      suspendedAt: new Date("2026-09-04T00:00:00Z"),
    });
  });
});

describe("toRepositoryRecord", () => {
  it("maps app-client repository info", () => {
    expect(toRepositoryRecord(repositoryInfo)).toEqual({
      id: 555001,
      owner: "octo-org",
      name: "api",
      fullName: "octo-org/api",
      defaultBranch: "main",
      private: true,
    });
  });

  it("maps an installation webhook repository ref without inventing a default branch", () => {
    const event = parseWebhookEvent("installation_repositories", installationRepositoriesAdded);
    if (event.kind !== "installation_repositories") throw new Error("fixture did not parse");
    const [ref] = event.repositories_added;
    const record = toRepositoryRecord(ref as NonNullable<typeof ref>);
    expect(record).toEqual({
      id: 555003,
      owner: "octo-org",
      name: "worker",
      fullName: "octo-org/worker",
      private: true,
    });
    expect(record).not.toHaveProperty("defaultBranch");
  });

  it("maps a pull request webhook repository with owner and default branch", () => {
    expect(toRepositoryRecord(pullRequestEvent().repository)).toEqual({
      id: 555001,
      owner: "octo-org",
      name: "api",
      fullName: "octo-org/api",
      defaultBranch: "main",
      private: true,
    });
  });

  it("rejects a malformed full name", () => {
    expect(() =>
      toRepositoryRecord({ id: 1, name: "api", full_name: "api", private: false }),
    ).toThrow("invalid_repository_full_name");
  });
});
