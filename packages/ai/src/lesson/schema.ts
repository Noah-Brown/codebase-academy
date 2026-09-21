import { CRITERION_RESULTS, OBJECTIVE_MODES, OPEN_RESPONSE_MODES } from "@academy/learning";
import { z } from "zod";

/** What the lesson generator returns. Structure is enforced by `validateLessonOutput`. */
export const lessonOutputSchema = z.object({
  title: z.string(),
  estimatedMinutes: z.number(),
  rationale: z.string(),
  objectiveIndexes: z.array(z.number().int()),
  steps: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("explanation"),
        title: z.string(),
        body: z.string(),
        evidenceIds: z.array(z.string()),
      }),
      z.object({
        type: z.literal("multiple_choice"),
        mode: z.enum(OBJECTIVE_MODES),
        prompt: z.string(),
        evidenceIds: z.array(z.string()),
        choices: z.array(z.object({ id: z.string(), text: z.string() })),
        correctChoiceId: z.string(),
        explanation: z.string(),
        objectiveIndex: z.number().int(),
      }),
      z.object({
        type: z.literal("open_response"),
        mode: z.enum(OPEN_RESPONSE_MODES),
        prompt: z.string(),
        evidenceIds: z.array(z.string()),
        rubric: z.array(
          z.object({
            criterion: z.string(),
            weight: z.number(),
            expectedSignals: z.array(z.string()),
          }),
        ),
        exemplarSummary: z.string(),
        objectiveIndex: z.number().int(),
      }),
      z.object({ type: z.literal("takeaway"), points: z.array(z.string()) }),
    ]),
  ),
});
export type LessonOutput = z.infer<typeof lessonOutputSchema>;

const stringArray = { type: "array", items: { type: "string" } } as const;
const closed = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

/** JSON Schema for the same shape, limited to keywords both providers accept. */
export const lessonOutputJsonSchema = closed(
  ["title", "estimatedMinutes", "rationale", "objectiveIndexes", "steps"],
  {
    title: { type: "string" },
    estimatedMinutes: { type: "integer" },
    rationale: { type: "string" },
    objectiveIndexes: { type: "array", items: { type: "integer" } },
    steps: {
      type: "array",
      items: {
        anyOf: [
          closed(["type", "title", "body", "evidenceIds"], {
            type: { const: "explanation" },
            title: { type: "string" },
            body: { type: "string" },
            evidenceIds: stringArray,
          }),
          closed(
            [
              "type",
              "mode",
              "prompt",
              "evidenceIds",
              "choices",
              "correctChoiceId",
              "explanation",
              "objectiveIndex",
            ],
            {
              type: { const: "multiple_choice" },
              mode: { type: "string", enum: [...OBJECTIVE_MODES] },
              prompt: { type: "string" },
              evidenceIds: stringArray,
              choices: {
                type: "array",
                items: closed(["id", "text"], { id: { type: "string" }, text: { type: "string" } }),
              },
              correctChoiceId: { type: "string" },
              explanation: { type: "string" },
              objectiveIndex: { type: "integer" },
            },
          ),
          closed(
            [
              "type",
              "mode",
              "prompt",
              "evidenceIds",
              "rubric",
              "exemplarSummary",
              "objectiveIndex",
            ],
            {
              type: { const: "open_response" },
              mode: { type: "string", enum: [...OPEN_RESPONSE_MODES] },
              prompt: { type: "string" },
              evidenceIds: stringArray,
              rubric: {
                type: "array",
                items: closed(["criterion", "weight", "expectedSignals"], {
                  criterion: { type: "string" },
                  weight: { type: "number" },
                  expectedSignals: stringArray,
                }),
              },
              exemplarSummary: { type: "string" },
              objectiveIndex: { type: "integer" },
            },
          ),
          closed(["type", "points"], { type: { const: "takeaway" }, points: stringArray }),
        ],
      },
    },
  },
) satisfies Record<string, unknown>;

/** What the open-response grader returns. Checked by `validateGraderOutput`. */
export const graderOutputSchema = z.object({
  criterionResults: z.array(
    z.object({
      criterionIndex: z.number().int(),
      met: z.enum(CRITERION_RESULTS),
      evidenceFromAnswer: z.string(),
    }),
  ),
  feedback: z.string(),
  misconceptionConceptIds: z.array(z.string()),
  graderConfidence: z.number(),
});
export type GraderOutput = z.infer<typeof graderOutputSchema>;

export const graderOutputJsonSchema = closed(
  ["criterionResults", "feedback", "misconceptionConceptIds", "graderConfidence"],
  {
    criterionResults: {
      type: "array",
      items: closed(["criterionIndex", "met", "evidenceFromAnswer"], {
        criterionIndex: { type: "integer" },
        met: { type: "string", enum: [...CRITERION_RESULTS] },
        evidenceFromAnswer: { type: "string" },
      }),
    },
    feedback: { type: "string" },
    misconceptionConceptIds: stringArray,
    graderConfidence: { type: "number" },
  },
) satisfies Record<string, unknown>;
