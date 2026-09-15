import { LESSON_DEPTHS } from "@academy/learning";
import { z } from "zod";

/**
 * The shape the model is asked to return. Ranges are deliberately not expressed here: structured
 * outputs cannot enforce numeric bounds on every provider, so `validateMapperOutput` enforces them
 * and drops what fails.
 */
export const mapperOutputSchema = z.object({
  mappings: z.array(
    z.object({
      conceptId: z.string(),
      relevance: z.number(),
      significance: z.number(),
      suggestedDepth: z.enum(LESSON_DEPTHS),
      evidence: z.array(
        z.object({
          path: z.string(),
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
          excerpt: z.string(),
          rationale: z.string(),
        }),
      ),
    }),
  ),
});
export type MapperOutput = z.infer<typeof mapperOutputSchema>;

/**
 * Hand-written JSON Schema for the same shape, limited to keywords both the Claude CLI and the
 * Messages API structured outputs accept (no numeric or length constraints, closed objects).
 */
export const mapperOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mappings"],
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["conceptId", "relevance", "significance", "suggestedDepth", "evidence"],
        properties: {
          conceptId: { type: "string", description: "An ID from the allowed curriculum." },
          relevance: { type: "number", description: "0 to 1." },
          significance: { type: "number", description: "0 to 1." },
          suggestedDepth: { type: "string", enum: [...LESSON_DEPTHS] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "excerpt", "rationale"],
              properties: {
                path: { type: "string" },
                startLine: { type: "integer" },
                endLine: { type: "integer" },
                excerpt: { type: "string" },
                rationale: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;
