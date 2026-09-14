import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createGitHubApp, TOKEN_REFRESH_MARGIN_MS } from "./app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const T0 = new Date("2026-09-01T12:00:00Z");

interface Call {
  method: string;
  path: string;
  url: URL;
  authorization: string | null;
}

type Route = (url: URL, match: RegExpMatchArray) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Real fetch responses carry their URL; Octokit's paginator reads it. */
function withUrl(response: Response, url: URL): Response {
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}

function nextLink(url: URL, page: number): Record<string, string> {
  const next = new URL(url.href);
  next.searchParams.set("page", String(page));
  return { link: `<${next.href}>; rel="next"` };
}

/** A fake GitHub API: routes are `METHOD /path-regex`; token minting is built in. */
function createFakeGitHub(routes: Array<[string, RegExp, Route]> = []) {
  const calls: Call[] = [];
  let minted = 0;
  const clock = { now: T0 };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : "url" in input ? input.url : input.href,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ method, path, url, authorization });

    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && tokenMatch) {
      minted += 1;
      return json(201, {
        token: `ghs_installation${tokenMatch[1]}_${minted}`,
        expires_at: new Date(clock.now.getTime() + 60 * 60 * 1000).toISOString(),
        permissions: { contents: "read", metadata: "read", pull_requests: "read" },
        repository_selection: "all",
      });
    }
    for (const [routeMethod, pattern, handler] of routes) {
      const match = path.match(pattern);
      if (routeMethod === method && match) return withUrl(handler(url, match), url);
    }
    return withUrl(json(404, { message: "Not Found" }), url);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    clock,
    minted: () => minted,
    app: () =>
      createGitHubApp({
        appId: 424242,
        privateKey,
        fetch: fetch as typeof globalThis.fetch,
        now: () => clock.now,
      }),
  };
}

const repositoryJson = (id: number, name: string) => ({
  id,
  name,
  full_name: `octo-org/${name}`,
  owner: { login: "octo-org" },
  default_branch: "main",
  private: true,
  archived: false,
});

const pullJson = (number: number) => ({
  number,
  title: `PR ${number}`,
  state: "open",
  draft: false,
  user: { login: "octocat" },
  html_url: `https://github.com/octo-org/api/pull/${number}`,
  body: "Body text",
  merged: false,
  additions: 3,
  deletions: 1,
  changed_files: 2,
  base: { ref: "main", sha: "base-sha", repo: repositoryJson(555001, "api") },
  head: { ref: "feature", sha: "head-sha" },
  updated_at: "2026-09-01T12:05:00Z",
});

/** `patch: null` models GitHub omitting the patch. */
const fileJson = (index: number, patch: string | null = "@@ -1 +1 @@\n-a\n+b") => ({
  sha: `sha${index}`,
  filename: `src/file${String(index).padStart(4, "0")}.ts`,
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  ...(patch === null ? {} : { patch }),
});

const pullRoute: [string, RegExp, Route] = [
  "GET",
  /^\/repos\/octo-org\/api\/pulls\/(\d+)$/,
  (_url, match) => json(200, pullJson(Number(match[1]))),
];

describe("createGitHubApp installation tokens", () => {
  let github: ReturnType<typeof createFakeGitHub>;
  beforeEach(() => {
    github = createFakeGitHub([pullRoute]);
  });

  it("mints one installation token across many calls and signs the JWT with the app key", async () => {
    const app = github.app();
    for (let number = 1; number <= 4; number += 1) {
      const pull = await app.getPullRequest(7001, "octo-org", "api", number);
      expect(pull?.number).toBe(number);
    }
    expect(github.minted()).toBe(1);

    const apiCalls = github.calls.filter((call) => call.path.startsWith("/repos/"));
    expect(apiCalls).toHaveLength(4);
    for (const call of apiCalls) expect(call.authorization).toBe("token ghs_installation7001_1");

    const mint = github.calls.find((call) => call.method === "POST");
    const jwt = mint?.authorization?.replace(/^bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    const valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
    );
    expect(valid).toBe(true);
    expect(String(JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).iss)).toBe(
      "424242",
    );
  });

  it("shares the token cache across concurrent calls and client instances", async () => {
    const app = github.app();
    await Promise.all(
      [1, 2, 3].map((number) => app.getPullRequest(7001, "octo-org", "api", number)),
    );
    expect(app.installationClient(7001)).toBe(app.installationClient(7001));
    expect(github.minted()).toBe(1);
  });

  it("mints separate tokens per installation", async () => {
    const app = github.app();
    await app.getPullRequest(7001, "octo-org", "api", 1);
    await app.getPullRequest(7002, "octo-org", "api", 1);
    await app.getPullRequest(7001, "octo-org", "api", 2);
    expect(github.minted()).toBe(2);
  });

  it("refreshes a token within five minutes of expiry", async () => {
    const app = github.app();
    await app.getPullRequest(7001, "octo-org", "api", 1);
    github.clock.now = new Date(T0.getTime() + 60 * 60 * 1000 - TOKEN_REFRESH_MARGIN_MS - 1000);
    await app.getPullRequest(7001, "octo-org", "api", 1);
    expect(github.minted()).toBe(1);
    github.clock.now = new Date(T0.getTime() + 60 * 60 * 1000 - TOKEN_REFRESH_MARGIN_MS + 1000);
    await app.getPullRequest(7001, "octo-org", "api", 1);
    expect(github.minted()).toBe(2);
    expect(github.calls.at(-1)?.authorization).toBe("token ghs_installation7001_2");
  });

  it("accepts a private key with escaped newlines", async () => {
    const app = createGitHubApp({
      appId: 424242,
      privateKey: privateKey.replace(/\n/g, "\\n"),
      fetch: github.fetch,
    });
    await expect(app.getPullRequest(7001, "octo-org", "api", 1)).resolves.not.toBeNull();
  });
});

describe("createGitHubApp API methods", () => {
  it("gets an installation with the app JWT and returns null when missing", async () => {
    const github = createFakeGitHub([
      [
        "GET",
        /^\/app\/installations\/7001$/,
        () =>
          json(200, {
            id: 7001,
            account: { login: "octo-org", type: "Organization" },
            repository_selection: "selected",
            suspended_at: null,
          }),
      ],
    ]);
    const app = github.app();
    await expect(app.getInstallation(7001)).resolves.toEqual({
      id: 7001,
      accountLogin: "octo-org",
      accountType: "Organization",
      repositorySelection: "selected",
      suspendedAt: null,
    });
    expect(github.calls[0]?.authorization).toMatch(/^bearer /);
    await expect(app.getInstallation(9999)).resolves.toBeNull();
    expect(github.minted()).toBe(0);
  });

  it("paginates installation repositories", async () => {
    const github = createFakeGitHub([
      [
        "GET",
        /^\/installation\/repositories$/,
        (url) => {
          const page = Number(url.searchParams.get("page") ?? "1");
          const repositories =
            page === 1
              ? [repositoryJson(1, "api"), repositoryJson(2, "web")]
              : [repositoryJson(3, "worker")];
          return json(200, { total_count: 3, repositories }, page === 1 ? nextLink(url, 2) : {});
        },
      ],
    ]);
    const repositories = await github.app().listInstallationRepositories(7001);
    expect(repositories.map((repo) => repo.fullName)).toEqual([
      "octo-org/api",
      "octo-org/web",
      "octo-org/worker",
    ]);
    expect(repositories[0]).toEqual({
      id: 1,
      owner: "octo-org",
      name: "api",
      fullName: "octo-org/api",
      defaultBranch: "main",
      private: true,
      archived: false,
    });
  });

  it("lists open pull requests and normalizes a pull request", async () => {
    const github = createFakeGitHub([
      pullRoute,
      [
        "GET",
        /^\/repos\/octo-org\/api\/pulls$/,
        (url) => {
          expect(url.searchParams.get("state")).toBe("open");
          return json(200, [pullJson(1), pullJson(2)]);
        },
      ],
    ]);
    const app = github.app();
    const open = await app.listOpenPullRequests(7001, "octo-org", "api");
    expect(open.map((pull) => pull.number)).toEqual([1, 2]);
    expect(open[0]).not.toHaveProperty("body");

    const pull = await app.getPullRequest(7001, "octo-org", "api", 5);
    expect(pull).toMatchObject({
      number: 5,
      authorLogin: "octocat",
      baseSha: "base-sha",
      headSha: "head-sha",
      body: "Body text",
      changedFiles: 2,
      repository: { id: 555001, fullName: "octo-org/api", defaultBranch: "main" },
    });
    await expect(app.getPullRequest(7001, "octo-org", "missing", 5)).resolves.toBeNull();
  });

  it("paginates pull request files and reports omitted patches", async () => {
    const github = createFakeGitHub([
      [
        "GET",
        /^\/repos\/octo-org\/api\/pulls\/7\/files$/,
        (url) => {
          const page = Number(url.searchParams.get("page") ?? "1");
          if (page === 1) {
            return json(
              200,
              [fileJson(1), { ...fileJson(2, null), changes: 4000 }],
              nextLink(url, 2),
            );
          }
          return json(200, [
            { ...fileJson(3, null), filename: "logo.png", status: "added", changes: 0 },
            { ...fileJson(4), status: "renamed", previous_filename: "src/old.ts" },
          ]);
        },
      ],
    ]);
    const list = await github.app().listPullRequestFiles(7001, "octo-org", "api", 7);
    expect(list.truncated).toBe(false);
    expect(list.files.map((file) => file.path)).toEqual([
      "src/file0001.ts",
      "src/file0002.ts",
      "logo.png",
      "src/file0004.ts",
    ]);
    expect(list.omittedPatchPaths).toEqual(["src/file0002.ts"]);
    expect(list.files[2]).toMatchObject({ patchOmitted: false });
    expect(list.files[2]).not.toHaveProperty("patch");
    expect(list.files[3]).toMatchObject({ previousPath: "src/old.ts", status: "renamed" });
  });

  it("caps pull request files at 3,000 and flags truncation", async () => {
    const github = createFakeGitHub([
      [
        "GET",
        /^\/repos\/octo-org\/api\/pulls\/8\/files$/,
        (url) => {
          const page = Number(url.searchParams.get("page") ?? "1");
          const files = Array.from({ length: 100 }, (_, i) => fileJson((page - 1) * 100 + i));
          return json(200, files, page < 35 ? nextLink(url, page + 1) : {});
        },
      ],
    ]);
    const list = await github.app().listPullRequestFiles(7001, "octo-org", "api", 8);
    expect(list.files).toHaveLength(3000);
    expect(list.truncated).toBe(true);
    const pagesFetched = github.calls.filter((call) => call.path.endsWith("/files")).length;
    expect(pagesFetched).toBeLessThanOrEqual(31);
  });

  describe("getFileContent", () => {
    const content = (bytes: Buffer, overrides: Record<string, unknown> = {}) => ({
      type: "file",
      size: bytes.length,
      encoding: "base64",
      content: bytes.toString("base64"),
      ...overrides,
    });
    const files: Record<string, unknown> = {
      "src/index.ts": content(Buffer.from("export const answer = 42;\n")),
      "assets/logo.png": content(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])),
      "data/latin1.txt": content(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
      "src/big.ts": content(Buffer.from("x".repeat(2048))),
      "src/huge.ts": { type: "file", size: 2_000_000, encoding: "none", content: "" },
      src: [{ name: "index.ts", path: "src/index.ts", type: "file" }],
    };
    const github = createFakeGitHub([
      [
        "GET",
        /^\/repos\/octo-org\/api\/contents\/?(.*)$/,
        (url, match) => {
          expect(url.searchParams.get("ref")).toBe("head-sha");
          const file = files[match[1] ?? ""];
          return file === undefined ? json(404, { message: "Not Found" }) : json(200, file);
        },
      ],
    ]);
    const app = github.app();
    const get = (path: string, maxBytes = 1024) =>
      app.getFileContent(7001, "octo-org", "api", path, "head-sha", { maxBytes });

    it("returns decoded UTF-8 text", async () => {
      await expect(get("src/index.ts")).resolves.toEqual({
        text: "export const answer = 42;\n",
        size: 26,
      });
    });

    it("returns null for binary, non-UTF-8, oversize, missing, and directory paths", async () => {
      await expect(get("assets/logo.png")).resolves.toBeNull();
      await expect(get("data/latin1.txt")).resolves.toBeNull();
      await expect(get("src/big.ts")).resolves.toBeNull();
      await expect(get("src/big.ts", 4096)).resolves.not.toBeNull();
      await expect(get("src/huge.ts", 10_000_000)).resolves.toBeNull();
      await expect(get("src/missing.ts")).resolves.toBeNull();
      await expect(get("src")).resolves.toBeNull();
    });

    it("lists a directory", async () => {
      await expect(app.listDirectory(7001, "octo-org", "api", "src", "head-sha")).resolves.toEqual([
        { name: "index.ts", path: "src/index.ts", type: "file" },
      ]);
      await expect(
        app.listDirectory(7001, "octo-org", "api", "src/index.ts", "head-sha"),
      ).resolves.toBeNull();
    });
  });
});
