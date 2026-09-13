import { z } from "zod";

export const ASSESSMENT_MODES = [
  "recognize",
  "predict",
  "trace",
  "explain",
  "compare",
  "design",
  "defend",
] as const;

export type AssessmentMode = (typeof ASSESSMENT_MODES)[number];

/** Rank of a mode in the recognize → defend progression (higher is more demanding). */
export function assessmentModeRank(mode: AssessmentMode): number {
  return ASSESSMENT_MODES.indexOf(mode);
}

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase slug");
export const conceptIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, 'concept IDs look like "domain.concept-name"');

const nonEmptyText = z.string().trim().min(1);

export const curriculumDomainSchema = z.strictObject({
  id: slug,
  title: nonEmptyText,
  summary: nonEmptyText,
  order: z.number().int().nonnegative(),
});

export const curriculumConceptSchema = z.strictObject({
  id: conceptIdSchema,
  title: nonEmptyText,
  domain: slug,
  summary: nonEmptyText,
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  /**
   * 0..1 — how much misunderstanding this concept tends to cost in production
   * (security, data integrity, availability). Feeds the lesson ranker's
   * "operational/security importance" term. Extension to the brief's concept fields.
   */
  operationalImportance: z.number().min(0).max(1),
  prerequisites: z.array(conceptIdSchema),
  /**
   * Adjacent concepts that are NOT prerequisites, each with the boundary between
   * them — guidance for the concept mapper and lesson generator. Never used in
   * ranking or cycle checks.
   */
  related: z.array(z.strictObject({ id: conceptIdSchema, boundary: nonEmptyText })).optional(),
  learningObjectives: z.array(nonEmptyText).min(1),
  recognitionSignals: z.array(nonEmptyText).min(1),
  misconceptionPatterns: z.array(nonEmptyText).min(1),
  assessmentModes: z.array(z.enum(ASSESSMENT_MODES)).min(1),
  tags: z.array(slug),
  version: z.number().int().positive(),
});

/** One authored file: a domain plus the concepts that belong to it. */
export const curriculumDomainFileSchema = z.strictObject({
  domain: curriculumDomainSchema,
  concepts: z.array(curriculumConceptSchema),
});

export const curriculumSchema = z.strictObject({
  version: z.number().int().positive(),
  domains: z.array(curriculumDomainSchema).min(1),
  concepts: z.array(curriculumConceptSchema).min(1),
});

export type CurriculumDomain = z.infer<typeof curriculumDomainSchema>;
export type CurriculumConcept = z.infer<typeof curriculumConceptSchema>;
export type CurriculumDomainFile = z.infer<typeof curriculumDomainFileSchema>;
export type Curriculum = z.infer<typeof curriculumSchema>;
export type ConceptDifficulty = CurriculumConcept["difficulty"];
