import { createHmac } from "node:crypto";
import {
  getPullRequestForUser,
  linkVerifiedUserInstallation,
  listPullRequestsForUser,
  listRepositoriesForUser,
  schema,
  type DatabaseHandle,
} from "@academy/db";
import { createTestDatabase } from "@academy/db/testing";
import { createLogger } from "@academy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleWebhookDelivery } from "./webhook-handler";

const SECRET = "test-webhook-secret-123";
const log = createLogger({ write: () => {} });
let handle: DatabaseHandle;
let userId: string;

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function deliver(eventName: string, payload: unknown, signature?: string) {
  const rawBody = JSON.stringify(payload);
  return handleWebhookDelivery(
    handle.db,
    SECRET,
    { eventName, signature: signature ?? sign(rawBody), deliveryId: "d-1", rawBody },
    log,
  );
}

const installation = { id: 42, account: { login: "octo-org", type: "Organization" } };
const repository = { id: 7001, name: "api", full_name: "octo-org/api", private: true };
const pullRequestPayload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  installation: { id: 42 },
  repository: { ...repository, owner: { login: "octo-org" }, default_branch: "main" },
  pull_request: {
    number: 12,
    title: "Add retries to the payments client",
    state: "open",
    user: { login: "dev" },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: "payment-retry", sha: "b".repeat(40) },
    html_url: "https://github.com/octo-org/api/pull/12",
    updated_at: "2026-09-14T10:00:00Z",
    body: "Contains secrets like sk_live_" + "abcdefghijklmnopqrstuvwx that must not be stored",
    ...overrides,
  },
});

beforeAll(async () => {
  handle = await createTestDatabase();
  const [user] = await handle.db
    .insert(schema.users)
    .values({ name: "Owner", email: "owner@example.test" })
    .returning();
  userId = user!.id;
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

describe("handleWebhookDelivery", () => {
  it("rejects a bad signature before parsing or storing anything", async () => {
    const result = await deliver(
      "installation",
      { action: "created", installation },
      "sha256=" + "0".repeat(64),
    );
    expect(result).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await handle.db.select().from(schema.githubInstallations)).toEqual([]);
  });

  it("stores installations and repositories, but links no user from a webhook alone", async () => {
    const result = await deliver("installation", {
      action: "created",
      installation,
      repositories: [repository],
    });
    expect(result.status).toBe(202);
    expect(await handle.db.select().from(schema.repositories)).toHaveLength(1);
    expect(await listRepositoriesForUser(handle.db, userId)).toEqual([]);
  });

  it("makes pull requests visible only after the user's installation link is verified", async () => {
    await linkVerifiedUserInstallation(handle.db, { userId, installationId: 42 });
    await deliver("pull_request", pullRequestPayload());
    const prs = await listPullRequestsForUser(handle.db, userId, 7001, { state: "open" });
    expect(prs.map((pr) => [pr.number, pr.headSha])).toEqual([[12, "b".repeat(40)]]);
    const stored = JSON.stringify(await handle.db.select().from(schema.pullRequests));
    expect(stored).not.toContain("sk_live_");
  });

  it("updates the head on synchronize and marks merged pull requests", async () => {
    await deliver(
      "pull_request",
      pullRequestPayload({
        head: { ref: "payment-retry", sha: "c".repeat(40) },
        updated_at: "2026-09-14T11:00:00Z",
      }),
    );
    let [pr] = await listPullRequestsForUser(handle.db, userId, 7001);
    expect(pr!.headSha).toBe("c".repeat(40));

    await deliver(
      "pull_request",
      pullRequestPayload({ state: "closed", merged: true, updated_at: "2026-09-14T12:00:00Z" }),
    );
    [pr] = await listPullRequestsForUser(handle.db, userId, 7001);
    expect(pr!.state).toBe("merged");
    expect(await getPullRequestForUser(handle.db, userId, pr!.id)).not.toBeNull();
  });

  it("removes repositories and hides everything when the installation is deleted", async () => {
    await deliver("installation_repositories", {
      action: "removed",
      installation,
      repositories_added: [],
      repositories_removed: [repository],
    });
    expect(await listRepositoriesForUser(handle.db, userId)).toEqual([]);

    await deliver("installation_repositories", {
      action: "added",
      installation,
      repositories_added: [repository],
      repositories_removed: [],
    });
    expect(await listRepositoriesForUser(handle.db, userId)).toHaveLength(1);

    await deliver("installation", { action: "deleted", installation });
    expect(await listRepositoriesForUser(handle.db, userId)).toEqual([]);
  });

  it("acknowledges events it does not handle and rejects invalid JSON", async () => {
    expect((await deliver("star", { action: "created" })).body).toEqual({
      ok: true,
      kind: "ignored",
    });
    const rawBody = "{not json";
    const result = await handleWebhookDelivery(
      handle.db,
      SECRET,
      { eventName: "installation", signature: sign(rawBody), deliveryId: null, rawBody },
      log,
    );
    expect(result.status).toBe(400);
  });
});
