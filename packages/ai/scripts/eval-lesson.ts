/**
 * Live lesson evaluation: generates a lesson from a golden fixture with a real provider, then grades a
 * strong and a weak answer to its first open response. Each run is two or three model calls, so this
 * spends real usage.
 *
 *   npm run eval:lesson -w @academy/ai
 *   npm run eval:lesson -w @academy/ai -- --depth defense
 *
 * Provider settings come from .env (CONCEPT_MAPPER_*, D27); the Claude CLI is the default. The fixture
 * is synthetic, so printing lesson structure and scores is safe.
 */
import { getCurriculum } from "@academy/curriculum";
import { LESSON_DEPTHS, type LessonDepth } from "@academy/learning";
import { conceptMapperEnvSchema, parseEnv } from "@academy/shared";
import {
  ModelCallError,
  OutputValidationError,
  createStructuredModel,
  generateLesson,
  gradeOpenResponse,
  type OpenResponseStep,
} from "../src/index";
import { idempotencyEvidence, idempotencySources } from "../src/lesson/fixtures";

const args = process.argv.slice(2);
const depthArg = args.includes("--depth") ? args[args.indexOf("--depth") + 1] : "advanced";
if (!LESSON_DEPTHS.includes(depthArg as LessonDepth)) {
  console.error(`--depth must be one of ${LESSON_DEPTHS.join(", ")}`);
  process.exit(2);
}
const depth = depthArg as LessonDepth;

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
const concept = graph.require("web.idempotency");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function describeFailure(error: unknown): string {
  if (error instanceof ModelCallError) {
    const issues =
      error.cause instanceof OutputValidationError
        ? ` [${error.cause.issues.join(", ")}; ${JSON.stringify(error.cause.stats)}]`
        : "";
    return `${error.code}${issues}`;
  }
  return "unexpected_error";
}

console.log(`Lesson eval: web.idempotency at ${depth}, provider ${env.CONCEPT_MAPPER_PROVIDER}\n`);
let failed = false;

try {
  const { content, call } = await generateLesson({
    model,
    concept,
    graph,
    depth,
    learner: idempotencySources.learner,
    evidence: idempotencyEvidence,
    reasons: idempotencySources.reasons,
    pullRequestTitle: idempotencySources.pullRequestTitle,
  });
  console.log(
    `PASS  generation (${call.model}, out ${call.usage.outputTokens} tokens, ${seconds(call.durationMs)})`,
  );
  console.log(
    `      "${content.title}" · ${content.estimatedMinutes} min · ${content.objectives.length} objectives`,
  );
  content.steps.forEach((step, index) => {
    const detail =
      step.type === "multiple_choice"
        ? `${step.mode}, ${step.choices.length} choices`
        : step.type === "open_response"
          ? `${step.mode}, ${step.rubric.length} criteria`
          : step.type === "explanation"
            ? `${step.evidenceIds.length} evidence`
            : `${step.points.length} points`;
    console.log(`      ${index + 1}. ${step.type} (${detail})`);
  });

  const open = content.steps.find(
    (step): step is OpenResponseStep => step.type === "open_response",
  );
  if (!open) {
    console.log("\nSKIP  grading: this lesson has no open response");
  } else {
    const grade = (answer: string) =>
      gradeOpenResponse({ model, concept, graph, step: open, evidence: content.evidence, answer });
    const strong = await grade(open.exemplarSummary);
    const weak = await grade(
      "Maybe wrap the call in a try/catch and log the error so it doesn't crash.",
    );
    const ok =
      strong.graded.score >= 0.6 &&
      weak.graded.score <= 0.5 &&
      strong.graded.score > weak.graded.score;
    failed ||= !ok;
    console.log(
      `\n${ok ? "PASS" : "FAIL"}  grading (strong ${strong.graded.score.toFixed(2)} at confidence ${strong.graded.graderConfidence.toFixed(2)}, weak ${weak.graded.score.toFixed(2)} at confidence ${weak.graded.graderConfidence.toFixed(2)}; ${seconds(strong.call.durationMs + weak.call.durationMs)})`,
    );
    for (const [label, result] of [
      ["strong", strong],
      ["weak", weak],
    ] as const) {
      const unverified = result.graded.criterionResults.filter((r) => !r.verified);
      console.log(
        `      ${label}: ${result.graded.criterionResults.map((r) => r.met).join(", ")}${unverified.length ? ` (${unverified.length} unverified quote)` : ""}`,
      );
      // Synthetic fixture text, safe to print: shows why a quote failed verification.
      for (const miss of unverified)
        console.log(`        unverified quote: ${JSON.stringify(miss.evidenceFromAnswer)}`);
    }
  }
} catch (error) {
  failed = true;
  console.log(`FAIL  ${describeFailure(error)}`);
}

process.exit(failed ? 1 : 0);
