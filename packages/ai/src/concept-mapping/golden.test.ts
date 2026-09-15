import { getCurriculum } from "@academy/curriculum";
import { analysisContextSchema } from "@academy/github";
import { defaultLearningConfig } from "@academy/learning";
import { describe, expect, it } from "vitest";
import { createScriptedModel } from "../testing";
import { goldenFixtures } from "./golden/fixtures";
import { scoreGolden } from "./golden/score";
import { mapConcepts } from "./mapper";
import { buildConceptMapperPrompt } from "./prompt";
import { emptyDropCounts } from "./validate";

const { graph } = getCurriculum();
const { minRelevance } = defaultLearningConfig.ranking;

describe.each(goldenFixtures)("golden fixture $id", (fixture) => {
  it("is a valid analysis context whose expectations use real concept IDs", () => {
    expect(() => analysisContextSchema.parse(fixture.context)).not.toThrow();
    const { required, allowed, forbidden } = fixture.expected;
    for (const id of [...required, ...allowed, ...forbidden]) expect(graph.has(id), id).toBe(true);
    expect(required.filter((id) => allowed.includes(id) || forbidden.includes(id))).toEqual([]);
  });

  it("shows the model every included file", () => {
    const { prompt } = buildConceptMapperPrompt({ context: fixture.context, graph });
    for (const file of fixture.context.files.filter((f) => f.included)) {
      expect(prompt).toContain(JSON.stringify(file.path));
    }
  });

  it("validates the recorded answer into a passing mapping", async () => {
    const model = createScriptedModel([fixture.recordedOutput]);
    const result = await mapConcepts({ model, graph, context: fixture.context });

    expect(result.dropped).toEqual({ ...emptyDropCounts(), ...fixture.recordedDrops });
    const score = scoreGolden(fixture, result.mappings, minRelevance);
    expect(score, JSON.stringify(score)).toMatchObject({ passed: true });
  });
});

describe("scoreGolden", () => {
  const fixture = goldenFixtures[0]!;

  it("fails missing, unexpected, forbidden, weak, and ungrounded mappings", () => {
    const score = scoreGolden(
      fixture,
      [
        {
          conceptId: "web.retries",
          relevance: 0.05,
          significance: 0.5,
          suggestedDepth: "intro",
          evidence: [{ path: "src/elsewhere.ts", excerpt: "retry()", rationale: "r" }],
        },
        {
          conceptId: "db.indexes",
          relevance: 0.9,
          significance: 0.5,
          suggestedDepth: "intro",
          evidence: [{ path: "src/billing/chargeCustomer.ts", excerpt: "x", rationale: "r" }],
        },
      ],
      minRelevance,
    );
    expect(score).toMatchObject({
      passed: false,
      missingRequired: ["web.idempotency"],
      unexpected: ["db.indexes"],
      forbidden: ["db.indexes"],
      weakRequired: ["web.retries"],
      invalidPaths: ["src/elsewhere.ts"],
    });
  });
});
