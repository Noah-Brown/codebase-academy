import { describe, expect, it } from "vitest";
import { conceptMapperEnvSchema, invalidEnvKeys, parseEnv } from "./env";

describe("conceptMapperEnvSchema", () => {
  it("requires a provider", () => {
    expect(invalidEnvKeys(conceptMapperEnvSchema, {})).toEqual(["CONCEPT_MAPPER_PROVIDER"]);
    expect(invalidEnvKeys(conceptMapperEnvSchema, { CONCEPT_MAPPER_PROVIDER: "gpt" })).toEqual([
      "CONCEPT_MAPPER_PROVIDER",
    ]);
  });

  it("fills defaults for the Claude CLI and treats empty values as unset", () => {
    expect(
      parseEnv(conceptMapperEnvSchema, {
        CONCEPT_MAPPER_PROVIDER: "claude-cli",
        CONCEPT_MAPPER_MODEL: "",
      }),
    ).toEqual({
      CONCEPT_MAPPER_PROVIDER: "claude-cli",
      CONCEPT_MAPPER_MODEL: undefined,
      CONCEPT_MAPPER_EFFORT: "medium",
      CONCEPT_MAPPER_TIMEOUT_MS: 300_000,
      CLAUDE_CLI_PATH: "claude",
      ANTHROPIC_API_KEY: undefined,
    });
  });

  it("requires an API key only for the anthropic provider", () => {
    expect(
      invalidEnvKeys(conceptMapperEnvSchema, { CONCEPT_MAPPER_PROVIDER: "anthropic" }),
    ).toEqual(["ANTHROPIC_API_KEY"]);
    expect(
      invalidEnvKeys(conceptMapperEnvSchema, {
        CONCEPT_MAPPER_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-test",
      }),
    ).toEqual([]);
  });
});
