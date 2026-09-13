import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvValidationError, databaseEnvSchema, parseEnv } from "./env";
import { createLogger, redactFields } from "./logger";

describe("logger redaction", () => {
  it("replaces code-like and answer-like fields with size markers", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line), now: () => new Date(0) });

    log.info("analysis step", {
      analysisId: "a1",
      patch: "const secret = 'abc';",
      nested: { excerpt: "await fetch(url)", path: "src/a.ts" },
      learner_answer: "because retries",
    });

    const record = JSON.parse(lines[0]!);
    expect(record.analysisId).toBe("a1");
    expect(record.patch).toBe("[redacted 21 chars]");
    expect(record.nested.excerpt).toBe("[redacted 16 chars]");
    expect(record.nested.path).toBe("src/a.ts");
    expect(JSON.stringify(record)).not.toContain("retries");
    expect(JSON.stringify(record)).not.toContain("abc");
  });

  it("keeps operational telemetry fields that merely resemble sensitive names", () => {
    expect(
      redactFields({ statusCode: 500, inputTokens: 1200, errorCode: "E1", responseTimeMs: 40 }),
    ).toEqual({ statusCode: 500, inputTokens: 1200, errorCode: "E1", responseTimeMs: 40 });
    expect(redactFields({ accessToken: "t", github_private_key: "k", modelResponse: "r" })).toEqual(
      {
        accessToken: "[redacted 1 chars]",
        github_private_key: "[redacted 1 chars]",
        modelResponse: "[redacted 1 chars]",
      },
    );
  });

  it("redacts inside child bindings and arrays", () => {
    expect(redactFields([{ code: 1 }, { ok: true }])).toEqual([
      { code: "[redacted]" },
      { ok: true },
    ]);

    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line) }).child({
      Authorization: "Bearer x",
    });
    log.warn("hello");
    expect(JSON.parse(lines[0]!).Authorization).toBe("[redacted 8 chars]");
  });

  it("respects the level threshold", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (line) => lines.push(line) });
    log.info("skip");
    log.error("keep");
    expect(lines).toHaveLength(1);
  });
});

describe("parseEnv", () => {
  it("applies defaults and validates the database URL", () => {
    const env = parseEnv(databaseEnvSchema, { DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NODE_ENV).toBe("development");
  });

  it("reports every issue without echoing values", () => {
    const schema = z.object({ A: z.string().min(5), B: z.string() });
    try {
      parseEnv(schema, { A: "xyz" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues).toHaveLength(2);
      expect(issues.join()).not.toContain("xyz");
    }
  });

  it("rejects non-postgres URLs", () => {
    expect(() => parseEnv(databaseEnvSchema, { DATABASE_URL: "mysql://localhost/db" })).toThrow(
      EnvValidationError,
    );
  });
});
