import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ModelCallError,
  type ModelErrorCode,
  type StructuredModel,
  type StructuredResult,
} from "../model";

/**
 * Structured generation through a locally signed-in Claude Code CLI (`claude -p`), for a developer
 * running the app for themselves on their own subscription (D21). Every call is locked down: no
 * tools, no settings, hooks, or MCP servers, no saved session, an empty temporary working directory,
 * and an allow-listed environment that carries none of the worker's secrets.
 */

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/**
 * Variables the CLI needs to find its install and sign-in. `ANTHROPIC_API_KEY` is deliberately
 * absent: with it set, the CLI would silently bill the key instead of the subscription.
 */
export const CLAUDE_CLI_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
] as const;

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface ClaudeCliModelOptions {
  command?: string;
  /** A CLI model alias or full model name. */
  model?: string;
  effort?: ClaudeEffort;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Source environment to pick allow-listed variables from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnProcess;
  tmpRoot?: string;
}

export function claudeCliEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const name of CLAUDE_CLI_ENV_ALLOWLIST) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env as NodeJS.ProcessEnv;
}

export function claudeCliArgs(input: {
  model: string;
  effort: ClaudeEffort;
  systemPromptPath: string;
  jsonSchema: Record<string, unknown>;
}): string[] {
  return [
    "-p",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt-file",
    input.systemPromptPath,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(input.jsonSchema),
  ];
}

const envelopeSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  api_error_status: z.number().nullable().optional(),
  stop_reason: z.string().nullable().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
  modelUsage: z
    .record(z.string(), z.looseObject({ outputTokens: z.number().optional() }))
    .optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
}

const spawnFailure = (error: unknown) =>
  new ModelCallError(
    (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? "provider_unavailable"
      : "provider_error",
    { cause: error },
  );

function runProcess(
  run: SpawnProcess,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = run(command, args, { cwd: options.cwd, env: options.env });
    } catch (error) {
      reject(spawnFailure(error));
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const stop = (code: ModelErrorCode) => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      settle(() => reject(new ModelCallError(code)));
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("timeout");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) stop("invalid_output");
      else chunks.push(chunk);
    });
    // Drained but never read: CLI diagnostics can echo request content.
    child.stderr.resume();
    child.on("error", (error) => settle(() => reject(spawnFailure(error))));
    child.on("close", (exitCode) =>
      settle(() => resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") })),
    );
    // EPIPE when the CLI exits before reading stdin; the exit status reports that failure.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
  });
}

function failureCode(envelope: Envelope): ModelErrorCode {
  const status = envelope.api_error_status;
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413) return "request_rejected";
  if (envelope.stop_reason === "refusal") return "refused";
  if (envelope.stop_reason === "max_tokens") return "output_truncated";
  if (envelope.subtype.includes("structured_output")) return "invalid_output";
  return "provider_error";
}

/** The model that produced the answer; the CLI may also make a small background call on another. */
function primaryModel(envelope: Envelope): string | null {
  const entries = Object.entries(envelope.modelUsage ?? {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
  return entries[0]![0];
}

export function interpretClaudeCliOutput(
  outcome: ProcessOutcome,
  fallbackModel: string,
  elapsedMs: number,
): StructuredResult {
  let json: unknown;
  try {
    json = JSON.parse(outcome.stdout);
  } catch {
    throw new ModelCallError(outcome.exitCode === 0 ? "invalid_output" : "provider_error");
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new ModelCallError(outcome.exitCode === 0 ? "invalid_output" : "provider_error");
  }
  const envelope = parsed.data;
  if (envelope.is_error || outcome.exitCode !== 0) throw new ModelCallError(failureCode(envelope));
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    throw new ModelCallError(
      envelope.stop_reason === "refusal"
        ? "refused"
        : envelope.stop_reason === "max_tokens"
          ? "output_truncated"
          : "invalid_output",
    );
  }
  return {
    output: envelope.structured_output,
    provider: "claude-cli",
    model: primaryModel(envelope) ?? fallbackModel,
    usage: {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      cacheReadInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
    },
    durationMs: envelope.duration_ms ?? elapsedMs,
  };
}

export function createClaudeCliModel(options: ClaudeCliModelOptions = {}): StructuredModel {
  const command = options.command ?? "claude";
  const model = options.model ?? "sonnet";
  const effort = options.effort ?? "medium";
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;
  const env = claudeCliEnv(options.env ?? process.env);
  const run: SpawnProcess =
    options.spawn ?? ((cmd, args, spawnOptions) => spawn(cmd, args, spawnOptions));

  return {
    provider: "claude-cli",
    async generate(request, callOptions = {}) {
      const workdir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "academy-claude-"));
      const started = Date.now();
      try {
        const systemPromptPath = join(workdir, "system-prompt.md");
        await writeFile(systemPromptPath, request.system, { mode: 0o600 });
        const outcome = await runProcess(
          run,
          command,
          claudeCliArgs({ model, effort, systemPromptPath, jsonSchema: request.jsonSchema }),
          {
            cwd: workdir,
            env,
            stdin: request.prompt,
            timeoutMs,
            maxOutputBytes,
            signal: callOptions.signal,
          },
        );
        return interpretClaudeCliOutput(outcome, model, Date.now() - started);
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
    },
  };
}
