import { describe, expect, it } from "vitest";
import type { DirectoryEntry, PullRequestDetails, PullRequestFile } from "../types";
import { buildAnalysisContext, ContextBuildError, type PullRequestContextSource } from "./build";
import { ANALYZER_VERSION, analysisContextSchema, type AnalysisContext } from "./schema";

const HEAD = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
const GITHUB_TOKEN = "ghp_" + "A1b2C3d4".repeat(5).slice(0, 36);
const ANTHROPIC_KEY = "sk-ant-" + "api03-" + "Qw3rTy8uIoPaSdFgHjKl".repeat(2);
const NPM_TOKEN = "npm_" + "Zx9Yw8Vu7Ts6Rq5P";

function pullRequest(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    number: 42,
    title: "Add retry with backoff",
    state: "open",
    draft: false,
    authorLogin: "octocat",
    htmlUrl: "https://github.com/octo-org/api/pull/42",
    baseRef: "main",
    baseSha: "0a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d",
    headRef: "retry-backoff",
    headSha: HEAD,
    updatedAt: "2026-09-01T12:05:00Z",
    body: "Adds retries.",
    merged: false,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    repository: {
      id: 555001,
      owner: "octo-org",
      name: "api",
      fullName: "octo-org/api",
      defaultBranch: "main",
      private: true,
      archived: false,
    },
    ...overrides,
  };
}

/** One hunk of `context` unchanged lines plus one added line, starting at `start`. */
function hunk(start: number, context: number, label: string): string {
  return [
    `@@ -${start},${context} +${start},${context + 1} @@`,
    ...Array.from(
      { length: context },
      (_, i) => ` const ${label}${i} = computeValue(${i}); // unchanged`,
    ),
    `+const ${label}Added = retry(${context});`,
  ].join("\n");
}

function sourceFile(lines: number, special: Record<number, string> = {}): string {
  return (
    Array.from(
      { length: lines },
      (_, i) => special[i + 1] ?? `export const value${i + 1} = ${i + 1};`,
    ).join("\n") + "\n"
  );
}

function file(path: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  const patch = overrides.patch ?? hunk(1, 3, "x");
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
    patchOmitted: false,
    ...overrides,
  };
}

interface FakeSourceOptions {
  pr?: PullRequestDetails | null;
  files: PullRequestFile[];
  contents?: Record<string, string>;
  truncated?: boolean;
  rootEntries?: DirectoryEntry[] | null;
  reverseFiles?: boolean;
}

function createFakeSource(options: FakeSourceOptions) {
  const fetched: string[] = [];
  const source: PullRequestContextSource = {
    async getPullRequest() {
      return options.pr === undefined
        ? pullRequest({ changedFiles: options.files.length })
        : options.pr;
    },
    async listPullRequestFiles() {
      const files = structuredClone(options.files);
      return {
        files: options.reverseFiles ? files.reverse() : files,
        truncated: options.truncated ?? false,
        omittedPatchPaths: files.filter((f) => f.patchOmitted).map((f) => f.path),
      };
    },
    async getFileContent(_installationId, _owner, _repo, path, ref, { maxBytes }) {
      expect(ref).toBe(HEAD);
      fetched.push(path);
      const text = options.contents?.[path];
      if (text === undefined || text.length > maxBytes) return null;
      return { text, size: text.length };
    },
    ...(options.rootEntries === undefined
      ? {}
      : { listDirectory: async () => options.rootEntries ?? null }),
  };
  return { source, fetched };
}

const build = (source: PullRequestContextSource, config = {}) =>
  buildAnalysisContext({
    source,
    installationId: 7001,
    owner: "octo-org",
    repo: "api",
    pullNumber: 42,
    config,
  });

function mixedPullRequest(reverseFiles = false) {
  const retryPatch = Array.from({ length: 6 }, (_, i) => hunk(1 + i * 60, 40, `retry${i}`)).join(
    "\n",
  );
  const features = Array.from({ length: 10 }, (_, i) =>
    file(`src/features/feature${i}.ts`, {
      status: "added",
      additions: 50,
      changes: 50,
      patch:
        hunk(0, 0, "x").replace("@@ -0,0 +0,1 @@", "@@ -0,0 +1,50 @@") +
        "\n" +
        Array.from(
          { length: 49 },
          (_, j) => `+export function feature${i}Step${j}() { return ${j}; }`,
        ).join("\n"),
    }),
  );
  const files: PullRequestFile[] = [
    file("package-lock.json", { changes: 800, patch: hunk(1, 30, "lock") }),
    file("public/app.min.js", { changes: 2 }),
    file("assets/logo.png", { status: "added", changes: 0, additions: 0, patch: undefined }),
    file("src/legacy.ts", {
      status: "removed",
      additions: 0,
      deletions: 3,
      changes: 3,
      patch: "@@ -1,3 +0,0 @@\n-export const a = 1;\n-export const b = 2;\n-export const c = 3;",
    }),
    file("src/huge.ts", { changes: 1200, additions: 1200, patch: undefined, patchOmitted: true }),
    file("src/config.ts", {
      changes: 100,
      patch: [
        "@@ -14,3 +14,3 @@",
        " export const value14 = 14;",
        '-const apiKey = "placeholder";',
        `+const apiKey = "${ANTHROPIC_KEY}";`,
        " export const value16 = 16;",
      ].join("\n"),
    }),
    file("src/retry.ts", { changes: 240, additions: 6, patch: retryPatch }),
    file("src/retry.test.ts", { changes: 20, patch: hunk(1, 10, "test") }),
    file("docs/retry.md", { changes: 8, patch: hunk(1, 5, "doc") }),
    file("package.json", { changes: 2, patch: hunk(1, 2, "pkg") }),
    file("src/new-name.ts", {
      status: "renamed",
      previousPath: "src/old-name.ts",
      changes: 0,
      patch: undefined,
    }),
    ...features,
  ];
  const contents: Record<string, string> = {
    "src/config.ts": sourceFile(30, { 15: `const apiKey = "${ANTHROPIC_KEY}";` }),
    "src/retry.ts": sourceFile(400),
    "src/retry.test.ts": sourceFile(20),
    "docs/retry.md": sourceFile(10),
    "package.json": `{\n  "name": "api",\n  "token": "${NPM_TOKEN}",\n  "dependencies": { "zod": "^4.0.0" }\n}\n`,
  };
  const body =
    `Rotated the deploy token ${GITHUB_TOKEN} after the incident.\n\n` + "Details. ".repeat(400);
  return createFakeSource({
    pr: pullRequest({ body, changedFiles: files.length }),
    files,
    contents,
    rootEntries: [
      { name: "package.json", path: "package.json", type: "file" },
      { name: "src", path: "src", type: "dir" },
    ],
    reverseFiles,
  });
}

// retry.ts hunks are ~490 tokens each: one fits in 900, leaving room for its surrounding lines.
const CONFIG = { maxTotalTokens: 3_000, maxFileTokens: 900, contextRadius: 3, maxFiles: 60 };

describe("buildAnalysisContext end to end", () => {
  it("classifies, redacts, budgets, and validates a mixed pull request", async () => {
    const { source, fetched } = mixedPullRequest();
    const context = await build(source, CONFIG);
    const byPath = new Map(context.files.map((f) => [f.path, f]));

    expect(analysisContextSchema.safeParse(context).success).toBe(true);
    expect(context.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(context.repository).toEqual({
      id: 555001,
      fullName: "octo-org/api",
      defaultBranch: "main",
    });
    expect(context.files.map((f) => f.path)).toEqual([...context.files.map((f) => f.path)].sort());

    // Skip reasons.
    expect(byPath.get("package-lock.json")).toMatchObject({
      included: false,
      skipReason: "lockfile",
    });
    expect(byPath.get("public/app.min.js")).toMatchObject({
      included: false,
      skipReason: "generated",
    });
    expect(byPath.get("assets/logo.png")).toMatchObject({ included: false, skipReason: "binary" });
    expect(byPath.get("src/huge.ts")).toMatchObject({ included: false, skipReason: "no_patch" });
    expect(byPath.get("src/new-name.ts")).toMatchObject({
      included: true,
      previousPath: "src/old-name.ts",
      estimatedTokens: 0,
      hunks: [],
    });
    expect(context.warnings).toContain("patch_omitted:src/huge.ts");
    for (const skipped of [
      "package-lock.json",
      "public/app.min.js",
      "assets/logo.png",
      "src/huge.ts",
    ]) {
      expect(byPath.get(skipped)).toMatchObject({ estimatedTokens: 0, hunks: [], context: [] });
      expect(byPath.get(skipped)).not.toHaveProperty("patch");
    }

    // Head content is fetched only for included modified files and manifests; never for skipped or added files.
    expect(fetched).not.toContain("package-lock.json");
    expect(fetched).not.toContain("src/huge.ts");
    expect(fetched).not.toContain("assets/logo.png");
    expect(fetched).not.toContain("src/legacy.ts");
    expect(fetched.some((path) => path.startsWith("src/features/"))).toBe(false);
    expect(fetched).toContain("src/retry.ts");

    // Redaction: nothing raw survives; counts are recorded.
    const serialized = JSON.stringify(context);
    for (const secret of [GITHUB_TOKEN, ANTHROPIC_KEY, NPM_TOKEN])
      expect(serialized).not.toContain(secret);
    expect(context.redactions.github_token).toBe(1);
    expect(context.redactions.anthropic_api_key).toBeGreaterThanOrEqual(1);
    expect(context.redactions.secret_assignment).toBe(1);
    expect(context.pullRequest.body.length).toBeLessThanOrEqual(2_000);
    expect(context.pullRequest.body).toContain("[REDACTED:github_token]");
    expect(byPath.get("src/config.ts")?.patch).toContain('"[REDACTED:anthropic_api_key]"');

    // Manifests.
    expect(context.manifests.map((m) => m.path)).toEqual(["package.json"]);
    expect(context.manifests[0]?.excerpt).toContain('"token": "[REDACTED:secret_assignment]"');

    // Budget.
    const { budget } = context;
    expect(budget.maxTotalTokens).toBe(3_000);
    expect(budget.estimatedTokens).toBeLessThanOrEqual(budget.maxTotalTokens);
    const fileTokens = context.files.reduce((sum, f) => sum + f.estimatedTokens, 0);
    const prTokens =
      Math.ceil(context.pullRequest.title.length / 4) +
      Math.ceil(context.pullRequest.body.length / 4);
    const manifestTokens = context.manifests.reduce(
      (sum, m) => sum + Math.ceil(m.excerpt.length / 4),
      0,
    );
    expect(budget.estimatedTokens).toBe(fileTokens + prTokens + manifestTokens);
    for (const f of context.files)
      expect(f.estimatedTokens).toBeLessThanOrEqual(CONFIG.maxFileTokens);

    const retry = byPath.get("src/retry.ts");
    expect(retry).toMatchObject({ included: true, patchTruncated: true });
    expect(retry?.hunks.length).toBeGreaterThanOrEqual(1);
    expect(retry?.hunks.length).toBeLessThan(6);
    expect(budget.truncatedFiles).toContain("src/retry.ts");
    expect(retry?.context.length).toBeGreaterThanOrEqual(1);
    for (const window of retry?.context ?? []) {
      expect(window.startLine).toBeGreaterThanOrEqual(1);
      expect(window.endLine).toBeLessThanOrEqual(400);
      expect(window.text.split("\n")).toHaveLength(window.endLine - window.startLine + 1);
    }

    expect(budget.omittedFiles.length).toBeGreaterThan(0);
    for (const path of budget.omittedFiles) {
      expect(byPath.get(path)).toMatchObject({
        included: false,
        skipReason: "budget",
        estimatedTokens: 0,
      });
    }
    // Equal-priority files are admitted in path order, so the included features form a prefix.
    const features = context.files.filter((f) => f.path.startsWith("src/features/"));
    const includedFeatures = features.filter((f) => f.included).map((f) => f.path);
    expect(includedFeatures.length).toBeGreaterThan(0);
    expect(includedFeatures).toEqual(features.slice(0, includedFeatures.length).map((f) => f.path));

    expect(context.languages).toEqual({ js: 1, json: 2, md: 1, png: 1, ts: 16 });
  });

  it("is deterministic across runs and GitHub file order", async () => {
    const first = await build(mixedPullRequest().source, CONFIG);
    const second = await build(mixedPullRequest(true).source, CONFIG);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("stays within budget across a range of limits", async () => {
    for (const maxTotalTokens of [600, 1_000, 2_500, 5_000, 24_000]) {
      for (const maxFileTokens of [100, 400, 4_000]) {
        const context: AnalysisContext = await build(mixedPullRequest().source, {
          maxTotalTokens,
          maxFileTokens,
          contextRadius: 5,
        });
        expect(context.budget.estimatedTokens).toBeLessThanOrEqual(maxTotalTokens);
        for (const f of context.files) expect(f.estimatedTokens).toBeLessThanOrEqual(maxFileTokens);
      }
    }
  });
});

describe("buildAnalysisContext details", () => {
  it("counts redactions exactly when everything fits", async () => {
    const { source } = createFakeSource({
      pr: pullRequest({ body: `token ${GITHUB_TOKEN}`, changedFiles: 1 }),
      files: [
        file("src/config.ts", {
          patch: [
            "@@ -15,1 +15,1 @@",
            '-const apiKey = "placeholder";',
            `+const apiKey = "${ANTHROPIC_KEY}";`,
          ].join("\n"),
        }),
      ],
      contents: { "src/config.ts": sourceFile(30, { 15: `const apiKey = "${ANTHROPIC_KEY}";` }) },
      rootEntries: [],
    });
    const context = await build(source, { contextRadius: 2 });
    expect(context.redactions).toEqual({ anthropic_api_key: 2, github_token: 1 });
    expect(context.files[0]?.context).toEqual([
      {
        startLine: 13,
        endLine: 17,
        text: [
          "export const value13 = 13;",
          "export const value14 = 14;",
          'const apiKey = "[REDACTED:anthropic_api_key]";',
          "export const value16 = 16;",
          "export const value17 = 17;",
        ].join("\n"),
      },
    ]);
    expect(context.manifests).toEqual([]);
    expect(context.warnings).toEqual([]);
  });

  it("warns when the file list is truncated or content is unavailable", async () => {
    const { source } = createFakeSource({
      pr: pullRequest({ changedFiles: 5_000 }),
      files: [file("src/a.ts")],
      contents: {},
      truncated: true,
    });
    const context = await build(source);
    expect(context.warnings).toEqual([
      "github_file_list_truncated",
      "content_unavailable:src/a.ts",
    ]);
    expect(context.files[0]).toMatchObject({ included: true, context: [] });
  });

  it("does not fetch head content when contextRadius is 0", async () => {
    const { source, fetched } = createFakeSource({ files: [file("src/a.ts")], rootEntries: [] });
    const context = await build(source, { contextRadius: 0 });
    expect(fetched).toEqual([]);
    expect(context.files[0]?.context).toEqual([]);
  });

  it("probes root manifests without a directory listing and ignores missing ones", async () => {
    const { source, fetched } = createFakeSource({
      files: [file("src/a.ts", { status: "added" })],
      contents: { "go.mod": "module example.com/api\n\ngo 1.23\n" },
    });
    const context = await build(source);
    expect(fetched).toContain("pyproject.toml");
    expect(context.manifests).toEqual([
      { path: "go.mod", excerpt: "module example.com/api\n\ngo 1.23\n" },
    ]);
  });

  it("truncates the PR body to maxBodyChars after redaction", async () => {
    const { source } = createFakeSource({
      pr: pullRequest({ body: "b".repeat(5_000) }),
      files: [],
      rootEntries: [],
    });
    const context = await build(source, { maxBodyChars: 100 });
    expect(context.pullRequest.body).toBe("b".repeat(100));
  });

  it("fails with coded errors for a missing PR or a moved head", async () => {
    const missing = createFakeSource({ pr: null, files: [] }).source;
    await expect(build(missing)).rejects.toMatchObject({ code: "pull_request_not_found" });

    const { source } = createFakeSource({ files: [] });
    const error = await buildAnalysisContext({
      source,
      installationId: 7001,
      owner: "octo-org",
      repo: "api",
      pullNumber: 42,
      expectedHeadSha: "different",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextBuildError);
    expect(error).toMatchObject({ code: "head_sha_mismatch" });
  });

  it("rejects invalid config", async () => {
    const { source } = createFakeSource({ files: [] });
    await expect(build(source, { maxTotalTokens: -1 })).rejects.toThrow();
  });
});

describe("buildAnalysisContext large single-hunk files", () => {
  const lines = Array.from(
    { length: 1_500 },
    (_, i) => `+export const generatedValue${i} = compute(${i});`,
  );
  const patch = ["@@ -0,0 +1,1500 @@", ...lines].join("\n");
  const bigFile = () =>
    file("src/big-module.ts", { status: "added", additions: 1_500, changes: 1_500, patch });

  it("includes a newly added 1,500-line file, truncated inside its hunk", async () => {
    const { source } = createFakeSource({ files: [bigFile()], rootEntries: [] });
    const context = await build(source);
    const [big] = context.files;
    expect(big).toMatchObject({ path: "src/big-module.ts", included: true, patchTruncated: true });
    expect(context.budget.truncatedFiles).toEqual(["src/big-module.ts"]);
    expect(context.budget.omittedFiles).toEqual([]);
    expect(big?.estimatedTokens).toBeLessThanOrEqual(4_000);
    expect(big?.estimatedTokens).toBeGreaterThan(3_900);

    const patchLines = big?.patch?.split("\n") ?? [];
    const kept = patchLines.length - 2;
    expect(kept).toBeGreaterThanOrEqual(20);
    expect(patchLines[0]).toBe(`@@ -0,0 +1,${kept} @@`);
    expect(patchLines.slice(1, -1)).toEqual(lines.slice(0, kept));
    expect(patchLines.at(-1)).toBe(`\\ … truncated ${1_500 - kept} lines (budget)`);
    expect(big?.hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: kept }]);
  });

  it("omits it only when not even a minimal slice fits the remaining total budget", async () => {
    const { source } = createFakeSource({ files: [bigFile()], rootEntries: [] });
    const context = await build(source, { maxTotalTokens: 150 });
    expect(context.files[0]).toMatchObject({ included: false, skipReason: "budget" });
    expect(context.budget.omittedFiles).toEqual(["src/big-module.ts"]);
  });

  it("records empty added files as empty, not binary", async () => {
    const { source, fetched } = createFakeSource({
      files: [
        file("pkg/__init__.py", { status: "added", additions: 0, changes: 0, patch: undefined }),
      ],
      rootEntries: [],
    });
    const context = await build(source);
    expect(context.files[0]).toMatchObject({ included: false, skipReason: "empty" });
    expect(context.warnings).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
