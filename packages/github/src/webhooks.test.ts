import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import installationCreated from "./__fixtures__/installation.created.json";
import installationRepositoriesAdded from "./__fixtures__/installation_repositories.added.json";
import pullRequestOpened from "./__fixtures__/pull_request.opened.json";
import { parseWebhookEvent, verifyWebhookSignature } from "./webhooks";

const SECRET = "webhook-test-secret";
const BODY = JSON.stringify({ action: "opened", number: 1 });

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", async () => {
    await expect(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY))).resolves.toBe(true);
  });

  it("rejects a signature made with another secret", async () => {
    await expect(verifyWebhookSignature(SECRET, BODY, sign("other", BODY))).resolves.toBe(false);
  });

  it("rejects a tampered body", async () => {
    const signature = sign(SECRET, BODY);
    await expect(verifyWebhookSignature(SECRET, `${BODY} `, signature)).resolves.toBe(false);
  });

  it("rejects a header without the sha256= prefix or with the legacy sha1= prefix", async () => {
    const hex = sign(SECRET, BODY).slice("sha256=".length);
    await expect(verifyWebhookSignature(SECRET, BODY, hex)).resolves.toBe(false);
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(BODY).digest("hex")}`;
    await expect(verifyWebhookSignature(SECRET, BODY, sha1)).resolves.toBe(false);
    await expect(verifyWebhookSignature(SECRET, BODY, "sha256=not-hex")).resolves.toBe(false);
  });

  it("returns false (never throws) for missing inputs", async () => {
    await expect(verifyWebhookSignature(SECRET, BODY, null)).resolves.toBe(false);
    await expect(verifyWebhookSignature(SECRET, BODY, undefined)).resolves.toBe(false);
    await expect(verifyWebhookSignature(SECRET, BODY, "")).resolves.toBe(false);
    await expect(verifyWebhookSignature("", BODY, sign("", BODY || "x"))).resolves.toBe(false);
    await expect(verifyWebhookSignature(SECRET, "", sign(SECRET, "x"))).resolves.toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("parses installation.created with its repositories", () => {
    const event = parseWebhookEvent("installation", installationCreated);
    expect(event).toEqual({
      kind: "installation",
      action: "created",
      installation: { id: 12345678, account: { login: "octo-org", type: "Organization" } },
      repositories: [
        { id: 555001, name: "api", full_name: "octo-org/api", private: true },
        { id: 555002, name: "web", full_name: "octo-org/web", private: false },
      ],
    });
  });

  it.each(["deleted", "suspend", "unsuspend", "new_permissions_accepted"])(
    "parses installation.%s",
    (action) => {
      const payload = { ...structuredClone(installationCreated), action };
      const event = parseWebhookEvent("installation", payload);
      expect(event.kind).toBe("installation");
      if (event.kind === "installation") expect(event.action).toBe(action);
    },
  );

  it("parses installation_repositories added and removed", () => {
    const added = parseWebhookEvent("installation_repositories", installationRepositoriesAdded);
    expect(added).toEqual({
      kind: "installation_repositories",
      action: "added",
      installation: { id: 12345678, account: { login: "octo-org", type: "Organization" } },
      repositories_added: [
        { id: 555003, name: "worker", full_name: "octo-org/worker", private: true },
      ],
      repositories_removed: [],
    });

    const removedPayload = {
      ...structuredClone(installationRepositoriesAdded),
      action: "removed",
      repositories_removed: installationRepositoriesAdded.repositories_added,
      repositories_added: [],
    };
    const removed = parseWebhookEvent("installation_repositories", removedPayload);
    expect(removed.kind).toBe("installation_repositories");
    if (removed.kind === "installation_repositories") {
      expect(removed.action).toBe("removed");
      expect(removed.repositories_removed.map((repo) => repo.id)).toEqual([555003]);
    }
  });

  it("parses pull_request.opened without keeping the body", () => {
    const event = parseWebhookEvent("pull_request", pullRequestOpened);
    expect(event).toEqual({
      kind: "pull_request",
      action: "opened",
      installation: { id: 12345678 },
      repository: {
        id: 555001,
        name: "api",
        full_name: "octo-org/api",
        owner: { login: "octo-org" },
        default_branch: "main",
        private: true,
      },
      pull_request: {
        number: 42,
        title: "Add retry with backoff to webhook delivery",
        state: "open",
        user: { login: "octocat" },
        base: { ref: "main", sha: "0a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d" },
        head: { ref: "retry-backoff", sha: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c" },
        html_url: "https://github.com/octo-org/api/pull/42",
        updated_at: "2026-09-01T12:05:00Z",
        merged: false,
      },
    });
    expect(JSON.stringify(event)).not.toContain("Private details");
  });

  it.each(["reopened", "synchronize", "edited"])("parses pull_request.%s", (action) => {
    const event = parseWebhookEvent("pull_request", {
      ...structuredClone(pullRequestOpened),
      action,
    });
    expect(event.kind).toBe("pull_request");
  });

  it("parses a merged pull_request.closed", () => {
    const payload = structuredClone(pullRequestOpened);
    payload.action = "closed";
    payload.pull_request.state = "closed";
    payload.pull_request.merged = true;
    const event = parseWebhookEvent("pull_request", payload);
    expect(event.kind === "pull_request" && event.pull_request.merged).toBe(true);
  });

  it("ignores unsupported events and actions", () => {
    expect(parseWebhookEvent("push", { ref: "refs/heads/main" })).toEqual({
      kind: "ignored",
      reason: "unsupported_event:push",
    });
    expect(parseWebhookEvent(null, {})).toEqual({
      kind: "ignored",
      reason: "unsupported_event:missing",
    });
    expect(
      parseWebhookEvent("pull_request", {
        ...structuredClone(pullRequestOpened),
        action: "labeled",
      }),
    ).toEqual({ kind: "ignored", reason: "unsupported_action:pull_request.labeled" });
    expect(parseWebhookEvent("installation", { installation: {} })).toEqual({
      kind: "ignored",
      reason: "unsupported_action:installation.missing",
    });
  });

  it("ignores invalid payloads without echoing their content", () => {
    const { installation: _installation, ...withoutInstallation } =
      structuredClone(pullRequestOpened);
    expect(parseWebhookEvent("pull_request", withoutInstallation)).toEqual({
      kind: "ignored",
      reason: "invalid_payload:pull_request",
    });
    const badRepos = { ...structuredClone(installationRepositoriesAdded), repositories_added: "x" };
    expect(parseWebhookEvent("installation_repositories", badRepos)).toEqual({
      kind: "ignored",
      reason: "invalid_payload:installation_repositories",
    });
    expect(parseWebhookEvent("installation", null).kind).toBe("ignored");
    expect(parseWebhookEvent("installation", "created").kind).toBe("ignored");
  });
});
