/**
 * Live golden evaluation: runs the concept mapper on every golden fixture with a real provider and
 * scores the result. Each fixture is one model call, so this spends real usage.
 *
 *   npm run eval:mapper -w @academy/ai                         # all fixtures
 *   npm run eval:mapper -w @academy/ai -- --fixture migration-index
 *
 * Provider settings come from .env (CONCEPT_MAPPER_*); the Claude CLI is the default. Fixtures are
 * synthetic, so printing their concept IDs is safe.
 */
import { getCurriculum } from "@academy/curriculum";
import { defaultLearningConfig } from "@academy/learning";
import { conceptMapperEnvSchema, parseEnv } from "@academy/shared";
import { goldenFixtures } from "../src/concept-mapping/golden/fixtures";
import { scoreGolden } from "../src/concept-mapping/golden/score";
import { createStructuredModel, mapConcepts, ModelCallError } from "../src/index";

const args = process.argv.slice(2);
const only = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : undefined;
const fixtures = goldenFixtures.filter((fixture) => !only || fixture.id === only);
if (fixtures.length === 0) {
  console.error(
    `No golden fixture named ${only}. Known: ${goldenFixtures.map((f) => f.id).join(", ")}`,
  );
  process.exit(2);
}

const env = parseEnv(conceptMapperEnvSchema, {
  CONCEPT_MAPPER_PROVIDER: "claude-cli",
  ...process.env,
});
const model = createStructuredModel({
  provider: env.CONCEPT_MAPPER_PROVIDER,
  model: env.CONCEPT_MAPPER_MODEL,
  effort: env.CONCEPT_MAPPER_EFFORT,
  timeoutMs: env.CONCEPT_MAPPER_TIMEOUT_MS,
  claudeCliPath: env.CLAUDE_CLI_PATH,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
});
const { graph } = getCurriculum();
const { minRelevance } = defaultLearningConfig.ranking;

console.log(
  `Concept mapper eval: ${fixtures.length} fixture(s), provider ${env.CONCEPT_MAPPER_PROVIDER}, model ${env.CONCEPT_MAPPER_MODEL ?? "default"}, effort ${env.CONCEPT_MAPPER_EFFORT}\n`,
);

let failed = 0;
for (const fixture of fixtures) {
  try {
    const result = await mapConcepts({ model, graph, context: fixture.context });
    const score = scoreGolden(fixture, result.mappings, minRelevance);
    if (!score.passed) failed++;
    const call = result.call;
    console.log(
      `${score.passed ? "PASS" : "FAIL"}  ${fixture.id}  (${call?.model ?? "no call"}, in ${call?.usage.inputTokens ?? 0} + cached ${call?.usage.cacheReadInputTokens ?? 0}, out ${call?.usage.outputTokens ?? 0} tokens, ${((call?.durationMs ?? 0) / 1000).toFixed(1)}s)`,
    );
    for (const mapping of result.mappings) {
      console.log(
        `      ${mapping.conceptId}  relevance ${mapping.relevance.toFixed(2)}  significance ${mapping.significance.toFixed(2)}  ${mapping.suggestedDepth}  (${mapping.evidence.length} evidence)`,
      );
    }
    const problems = Object.entries({
      "missing required": score.missingRequired,
      unexpected: score.unexpected,
      forbidden: score.forbidden,
      "below minimum relevance": score.weakRequired,
      "invalid evidence paths": score.invalidPaths,
    }).filter(([, ids]) => ids.length > 0);
    for (const [label, ids] of problems) console.log(`      ${label}: ${ids.join(", ")}`);
    const dropped = Object.entries(result.dropped).filter(([, count]) => count > 0);
    if (dropped.length > 0) {
      console.log(
        `      dropped by validation: ${dropped.map(([reason, n]) => `${reason} ${n}`).join(", ")}`,
      );
    }
  } catch (error) {
    failed++;
    const code = error instanceof ModelCallError ? error.code : "unexpected_error";
    console.log(`FAIL  ${fixture.id}  (${code})`);
  }
}

console.log(`\n${fixtures.length - failed}/${fixtures.length} passed`);
process.exit(failed === 0 ? 0 : 1);
