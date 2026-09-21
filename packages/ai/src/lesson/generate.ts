import type { CurriculumConcept, CurriculumGraph } from "@academy/curriculum";
import type { LearningConfig, LessonDepth } from "@academy/learning";
import { ModelCallError, type StructuredModel, type StructuredResult } from "../model";
import {
  defaultGraderConfig,
  defaultLessonGeneratorConfig,
  type GraderConfig,
  type LessonGeneratorConfig,
} from "./config";
import type { LessonContent, LessonEvidence, LessonLearner, OpenResponseStep } from "./content";
import { buildGraderPrompt, buildLessonPrompt, lessonRepairNote } from "./prompt";
import {
  graderOutputJsonSchema,
  graderOutputSchema,
  lessonOutputJsonSchema,
  lessonOutputSchema,
} from "./schema";
import {
  OutputValidationError,
  allowedModes,
  validateGraderOutput,
  validateLessonOutput,
  type GradedResponse,
} from "./validate";

export type CallTelemetry = Omit<StructuredResult, "output">;

const telemetry = ({ output: _output, ...rest }: StructuredResult): CallTelemetry => rest;

/** Combined telemetry when a lesson took a repair call: every token and millisecond counts. */
function combine(first: CallTelemetry | null, next: CallTelemetry): CallTelemetry {
  if (!first) return next;
  return {
    ...next,
    usage: {
      inputTokens: first.usage.inputTokens + next.usage.inputTokens,
      outputTokens: first.usage.outputTokens + next.usage.outputTokens,
      cacheReadInputTokens: first.usage.cacheReadInputTokens + next.usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        first.usage.cacheCreationInputTokens + next.usage.cacheCreationInputTokens,
    },
    durationMs: first.durationMs + next.durationMs,
  };
}

/** Model output that fails schema or structure checks is invalid (retryable); issue codes are kept. */
function invalid(error: unknown): never {
  throw new ModelCallError("invalid_output", { cause: error });
}

export async function generateLesson(input: {
  model: StructuredModel;
  concept: CurriculumConcept;
  graph: CurriculumGraph;
  depth: LessonDepth;
  learner: LessonLearner;
  evidence: LessonEvidence[];
  reasons: string[];
  pullRequestTitle: string;
  config?: LessonGeneratorConfig;
  nonce?: string;
  signal?: AbortSignal;
}): Promise<{ content: LessonContent; call: CallTelemetry }> {
  const config = input.config ?? defaultLessonGeneratorConfig;
  if (input.evidence.length === 0 || allowedModes(input.concept, input.depth).length === 0) {
    throw new ModelCallError("request_rejected");
  }
  const { system, prompt } = buildLessonPrompt({ ...input, config });

  // A draft that breaks a structural rule gets one repair call that names the failed checks.
  let request = prompt;
  let call: CallTelemetry | null = null;
  let lastError: unknown;
  for (let draft = 0; draft <= config.repairAttempts; draft++) {
    const result = await input.model.generate(
      { system, prompt: request, jsonSchema: lessonOutputJsonSchema },
      { signal: input.signal },
    );
    call = combine(call, telemetry(result));

    const parsed = lessonOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      lastError = parsed.error;
      request = `${prompt}\n\n${lessonRepairNote(["schema_mismatch"], config)}`;
      continue;
    }
    try {
      const content = validateLessonOutput(parsed.data, {
        concept: input.concept,
        depth: input.depth,
        evidence: input.evidence,
        config,
      });
      return { content, call };
    } catch (error) {
      if (!(error instanceof OutputValidationError)) throw error;
      lastError = error;
      request = `${prompt}\n\n${lessonRepairNote(error.issues, config)}`;
    }
  }
  invalid(lastError);
}

export async function gradeOpenResponse(input: {
  model: StructuredModel;
  concept: CurriculumConcept;
  graph: CurriculumGraph;
  step: OpenResponseStep;
  evidence: LessonEvidence[];
  answer: string;
  learningConfig?: LearningConfig;
  config?: GraderConfig;
  nonce?: string;
  signal?: AbortSignal;
}): Promise<{ graded: GradedResponse; call: CallTelemetry }> {
  const config = input.config ?? defaultGraderConfig;
  const answer = input.answer.trim();
  if (answer === "" || answer.length > config.maxAnswerChars) {
    throw new ModelCallError("request_rejected");
  }
  const { system, prompt } = buildGraderPrompt({ ...input, answer });
  const result = await input.model.generate(
    { system, prompt, jsonSchema: graderOutputJsonSchema },
    { signal: input.signal },
  );

  const parsed = graderOutputSchema.safeParse(result.output);
  if (!parsed.success) invalid(parsed.error);
  try {
    const graded = validateGraderOutput(parsed.data, {
      step: input.step,
      answer,
      graph: input.graph,
      learningConfig: input.learningConfig,
      config,
    });
    return { graded, call: telemetry(result) };
  } catch (error) {
    if (error instanceof OutputValidationError) invalid(error);
    throw error;
  }
}
