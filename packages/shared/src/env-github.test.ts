import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  githubAppEnvSchema,
  invalidEnvKeys,
  parseEnv,
  webEnvSchema,
} from "./env";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

const complete = {
  DATABASE_URL: "postgres://u:p@localhost:5432/academy",
  AUTH_SECRET: "x".repeat(44),
  AUTH_GITHUB_ID: "Iv23liExample",
  AUTH_GITHUB_SECRET: "client-secret",
  APP_BASE_URL: "http://localhost:3000",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "codebase-academy-dev",
  GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
  GITHUB_APP_WEBHOOK_SECRET: "a-long-webhook-secret",
};

describe("GitHub and auth environment", () => {
  it("parses a complete configuration and restores newlines in the private key", () => {
    const env = parseEnv(webEnvSchema, complete);
    expect(env.GITHUB_APP_ID).toBe(123456);
    expect(env.GITHUB_APP_PRIVATE_KEY).toContain("\n");
    expect(env.GITHUB_APP_PRIVATE_KEY.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("reports which keys are missing or invalid without echoing values", () => {
    const keys = invalidEnvKeys(webEnvSchema, {
      ...complete,
      AUTH_SECRET: "short",
      GITHUB_APP_PRIVATE_KEY: "not-a-key",
      AUTH_GITHUB_ID: undefined,
    });
    expect(keys).toEqual(["AUTH_GITHUB_ID", "AUTH_SECRET", "GITHUB_APP_PRIVATE_KEY"]);
    expect(invalidEnvKeys(webEnvSchema, complete)).toEqual([]);
  });

  it("rejects a non-numeric app ID and an invalid slug", () => {
    expect(() =>
      parseEnv(githubAppEnvSchema, {
        ...complete,
        GITHUB_APP_ID: "abc",
        GITHUB_APP_SLUG: "My App",
      }),
    ).toThrow(EnvValidationError);
  });
});
