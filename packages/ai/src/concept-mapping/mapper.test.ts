import { getCurriculum } from "@academy/curriculum";
import { describe, expect, it } from "vitest";
import { ModelCallError } from "../model";
import { createScriptedModel } from "../testing";
import { contextFor, skippedFile } from "./golden/context";
import { goldenFixtures } from "./golden/fixtures";
import { mapConcepts } from "./mapper";
import { mapperOutputJsonSchema } from "./schema";

const { graph } = getCurriculum();
const fixture = goldenFixtures.find((f) => f.id === "unbounded-promise-all")!;

describe("mapConcepts", () => {
  it("does not call the model when no file was included", async () => {
    const model = createScriptedModel([{ mappings: [] }]);
    const result = await mapConcepts({
      model,
      graph,
      context: contextFor({
        title: "Bump lockfile",
        files: [skippedFile("package-lock.json", "lockfile")],
      }),
    });
    expect(result).toMatchObject({ mappings: [], call: null, skippedReason: "no_included_files" });
    expect(model.requests).toHaveLength(0);
  });

  it("sends the prompt and schema, then returns validated mappings with call telemetry", async () => {
    const model = createScriptedModel([fixture.recordedOutput], { model: "test-model" });
    const result = await mapConcepts({ model, graph, context: fixture.context });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.jsonSchema).toBe(mapperOutputJsonSchema);
    expect(model.requests[0]!.prompt).toContain("src/reports/exportInvoices.ts");
    expect(result.mappings.map((m) => m.conceptId)).toEqual([
      "systems.bounded-concurrency",
      "fundamentals.async-basics",
    ]);
    expect(result.dropped.duplicate_concept).toBe(1);
    expect(result.call).toMatchObject({ provider: "scripted", model: "test-model" });
  });

  it("treats output that does not match the schema as invalid", async () => {
    const model = createScriptedModel([{ mappings: [{ conceptId: "db.indexes" }] }]);
    await expect(mapConcepts({ model, graph, context: fixture.context })).rejects.toMatchObject({
      code: "invalid_output",
      retryable: true,
    });
  });

  it("propagates provider failures", async () => {
    const model = createScriptedModel([new ModelCallError("auth_failed")]);
    await expect(mapConcepts({ model, graph, context: fixture.context })).rejects.toMatchObject({
      code: "auth_failed",
      retryable: false,
    });
  });
});
