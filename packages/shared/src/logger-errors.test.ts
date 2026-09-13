import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

describe("logger error serialization", () => {
  it("includes the cause chain so root failures are visible", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line) });
    const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    log.error("database unreachable", {
      error: new Error("Failed query: select 1", { cause: root }),
    });

    const record = JSON.parse(lines[0]!);
    expect(record.error.message).toBe("Failed query: select 1");
    expect(record.error.cause.message).toContain("ECONNREFUSED");
  });

  it("drops bound query parameters from error messages and stacks", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line) });
    const error = new Error(
      "Failed query: insert into answers (body) values ($1)\nparams: my private answer about retries",
    );
    log.error("write failed", { error });

    const output = lines[0]!;
    expect(output).toContain("insert into answers");
    expect(output).toContain("params: [redacted]");
    expect(output).not.toContain("private answer");
  });
});
