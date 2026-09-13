/**
 * Minimal structured JSON logger.
 *
 * Private source code and learner answers must never reach ordinary logs.
 * Fields whose names indicate such content are replaced with a size marker
 * before serialization, so an accidental `log.info("x", { patch })` is safe.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys redacted only when they are the whole name (so `statusCode` stays visible). */
const SENSITIVE_WHOLE_KEYS = new Set([
  "code",
  "sourcecode",
  "source",
  "content",
  "prompt",
  "completion",
  "authorization",
  "privatekey",
  "apikey",
]);

/** Keys redacted when they are the final word (`learnerAnswer`, `pr_patch`, `accessToken`). */
const SENSITIVE_FINAL_WORDS = new Set([
  "patch",
  "diff",
  "excerpt",
  "snippet",
  "answer",
  "response",
  "token",
  "secret",
  "password",
]);

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
  write?: (line: string) => void;
  now?: () => Date;
}

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  const joined = words.join("");
  return (
    SENSITIVE_WHOLE_KEYS.has(joined) ||
    SENSITIVE_FINAL_WORDS.has(words.at(-1) ?? "") ||
    /(private|api)key$/.test(joined)
  );
}

/**
 * Query-builder errors embed bound parameters in their message and stack
 * (e.g. Drizzle's "Failed query: …\nparams: …"), and parameters can carry code
 * excerpts or learner answers. Keep the SQL shape, drop the values.
 */
function scrubErrorText(text: string | undefined): string | undefined {
  return text?.replace(/^params:.*$/gm, "params: [redacted]");
}

export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubErrorText(value.message),
      stack: scrubErrorText(value.stack),
      ...(value.cause === undefined ? {} : { cause: redactFields(value.cause, depth + 1) }),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redactFields(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        const size = typeof inner === "string" ? inner.length : undefined;
        out[key] = size === undefined ? "[redacted]" : `[redacted ${size} chars]`;
      } else {
        out[key] = redactFields(inner, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = redactFields({ ...bindings, ...fields }) as LogFields;
    write(JSON.stringify({ time: now().toISOString(), level, message, ...record }));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}
