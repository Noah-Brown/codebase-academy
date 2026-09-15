import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ModelCallError } from "../model";
import { createClaudeCliModel, type SpawnProcess } from "./claude-cli";

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  systemPrompt: string;
  stdin: Promise<string>;
  kill: ReturnType<typeof vi.fn>;
}

type Behavior =
  { stdout: string; exitCode?: number } | { error: NodeJS.ErrnoException } | { hang: true };

function fakeSpawn(behavior: Behavior): { spawn: SpawnProcess; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill });
    const systemPromptIndex = args.indexOf("--system-prompt-file") + 1;

    const chunks: Buffer[] = [];
    const stdinText = new Promise<string>((resolve) => {
      stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      systemPrompt: readFileSync(args[systemPromptIndex]!, "utf8"),
      stdin: stdinText,
      kill,
    });

    void stdinText.then(() => {
      if ("error" in behavior) child.emit("error", behavior.error);
      else if ("stdout" in behavior) {
        stdout.end(behavior.stdout);
        setImmediate(() => child.emit("close", behavior.exitCode ?? 0));
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, calls };
}

const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    api_error_status: null,
    stop_reason: "tool_use",
    structured_output: { mappings: [] },
    usage: {
      input_tokens: 12,
      output_tokens: 340,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 80,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": { outputTokens: 13 },
      "claude-sonnet-5": { outputTokens: 340 },
    },
    ...overrides,
  });

const request = {
  system: "You map code to concepts.",
  prompt: "<file-abc>secret-looking repository content</file-abc>",
  jsonSchema: { type: "object", additionalProperties: false, properties: {} },
};

const sourceEnv = {
  HOME: "/home/dev",
  PATH: "/usr/bin",
  LANG: "C.UTF-8",
  DATABASE_URL: "postgres://academy:academy@localhost/academy",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  AUTH_SECRET: "x".repeat(40),
  ANTHROPIC_API_KEY: "sk-ant-api-key",
};

const roots: string[] = [];
const tmpRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "claude-cli-test-"));
  roots.push(root);
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("createClaudeCliModel", () => {
  it("runs a locked-down CLI with the prompt on stdin and returns the structured output", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: envelope() });
    const model = createClaudeCliModel({
      spawn,
      env: sourceEnv,
      tmpRoot: tmpRoot(),
      model: "sonnet",
      effort: "low",
    });

    const result = await model.generate(request);

    const call = calls[0]!;
    expect(call.command).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--tools",
      "",
      "--restricted",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt-file",
      join(call.cwd, "system-prompt.md"),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(request.jsonSchema),
    ]);
    expect(call.args.join(" ")).not.toContain("repository content");
    expect(await call.stdin).toBe(request.prompt);
    expect(call.systemPrompt).toBe(request.system);
    expect(result).toEqual({
      output: { mappings: [] },
      provider: "claude-cli",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 12,
        outputTokens: 340,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 80,
      },
      durationMs: 1234,
    });
  });

  it("passes only allow-listed environment variables, never app secrets or an API key", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: envelope() });
    await createClaudeCliModel({ spawn, env: sourceEnv, tmpRoot: tmpRoot() }).generate(request);
    expect(calls[0]!.env).toEqual({ HOME: "/home/dev", PATH: "/usr/bin", LANG: "C.UTF-8" });
  });

  it("runs in a fresh temporary directory that is removed afterwards", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawn({ stdout: envelope() });
    await createClaudeCliModel({ spawn, env: sourceEnv, tmpRoot: root }).generate(request);
    expect(dirname(calls[0]!.cwd)).toBe(root);
    expect(existsSync(calls[0]!.cwd)).toBe(false);
  });

  it.each([
    [
      { is_error: true, subtype: "error_during_execution", api_error_status: 429 },
      "rate_limited",
      true,
    ],
    [
      { is_error: true, subtype: "error_during_execution", api_error_status: 401 },
      "auth_failed",
      false,
    ],
    [{ is_error: true, subtype: "error_max_structured_output_retries" }, "invalid_output", true],
    [{ structured_output: undefined }, "invalid_output", true],
    [{ structured_output: undefined, stop_reason: "refusal" }, "refused", false],
  ])("maps a CLI result %j to %s", async (overrides, code, retryable) => {
    const { spawn } = fakeSpawn({ stdout: envelope(overrides) });
    const model = createClaudeCliModel({ spawn, env: sourceEnv, tmpRoot: tmpRoot() });
    await expect(model.generate(request)).rejects.toMatchObject({ code, retryable });
  });

  it("distinguishes unparseable output from a crashed CLI", async () => {
    const garbage = fakeSpawn({ stdout: "not json" });
    await expect(
      createClaudeCliModel({ spawn: garbage.spawn, env: sourceEnv, tmpRoot: tmpRoot() }).generate(
        request,
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });

    const crashed = fakeSpawn({ stdout: "", exitCode: 1 });
    await expect(
      createClaudeCliModel({ spawn: crashed.spawn, env: sourceEnv, tmpRoot: tmpRoot() }).generate(
        request,
      ),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("reports a missing CLI as unavailable", async () => {
    const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { spawn } = fakeSpawn({ error });
    await expect(
      createClaudeCliModel({ spawn, env: sourceEnv, tmpRoot: tmpRoot() }).generate(request),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("kills a CLI that runs past the timeout", async () => {
    const { spawn, calls } = fakeSpawn({ hang: true });
    const model = createClaudeCliModel({
      spawn,
      env: sourceEnv,
      tmpRoot: tmpRoot(),
      timeoutMs: 20,
    });
    await expect(model.generate(request)).rejects.toBeInstanceOf(ModelCallError);
    await expect(model.generate(request)).rejects.toMatchObject({ code: "timeout" });
    expect(calls[0]!.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops reading output past the size limit", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: envelope({ padding: "x".repeat(2_000) }) });
    const model = createClaudeCliModel({
      spawn,
      env: sourceEnv,
      tmpRoot: tmpRoot(),
      maxOutputBytes: 500,
    });
    await expect(model.generate(request)).rejects.toMatchObject({ code: "invalid_output" });
    expect(calls[0]!.kill).toHaveBeenCalled();
  });
});
