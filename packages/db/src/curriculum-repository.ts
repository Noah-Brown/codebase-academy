import { createHash } from "node:crypto";
import { validateCurriculum, type Curriculum } from "@academy/curriculum";
import { desc, eq } from "drizzle-orm";
import type { Database } from "./client";
import {
  curriculumConcepts,
  curriculumDomains,
  curriculumPrerequisites,
  curriculumVersions,
} from "./schema";

export class CurriculumVersionConflictError extends Error {
  constructor(public readonly version: number) {
    super(
      `Curriculum version ${version} is already imported with different content. ` +
        "Published versions are immutable; bump the version in data/curriculum.json.",
    );
    this.name = "CurriculumVersionConflictError";
  }
}

/** Stable JSON: object keys sorted, arrays of domains/concepts sorted by ID. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function curriculumContentHash(curriculum: Curriculum): string {
  const normalized = {
    ...curriculum,
    domains: [...curriculum.domains].sort((a, b) => a.id.localeCompare(b.id)),
    concepts: [...curriculum.concepts].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex");
}

export type CurriculumImportResult =
  | { status: "imported"; version: number; contentHash: string; conceptCount: number }
  | { status: "unchanged"; version: number; contentHash: string; conceptCount: number };

/**
 * Import a validated curriculum. Idempotent for identical content; refuses to
 * silently change a version that has already been published.
 */
export async function importCurriculum(
  db: Database,
  curriculum: Curriculum,
): Promise<CurriculumImportResult> {
  const errors = validateCurriculum(curriculum).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Refusing to import invalid curriculum: ${errors.map((e) => e.message).join("; ")}`,
    );
  }

  const contentHash = curriculumContentHash(curriculum);
  const conceptCount = curriculum.concepts.length;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(curriculumVersions)
      .where(eq(curriculumVersions.version, curriculum.version));
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new CurriculumVersionConflictError(curriculum.version);
      }
      return { status: "unchanged", version: curriculum.version, contentHash, conceptCount };
    }

    const version = curriculum.version;
    await tx.insert(curriculumVersions).values({ version, contentHash, conceptCount });
    await tx.insert(curriculumDomains).values(
      curriculum.domains.map((domain) => ({
        curriculumVersion: version,
        id: domain.id,
        title: domain.title,
        summary: domain.summary,
        position: domain.order,
      })),
    );
    await tx.insert(curriculumConcepts).values(
      curriculum.concepts.map((concept) => ({
        curriculumVersion: version,
        id: concept.id,
        domainId: concept.domain,
        title: concept.title,
        summary: concept.summary,
        difficulty: concept.difficulty,
        operationalImportance: concept.operationalImportance,
        learningObjectives: concept.learningObjectives,
        recognitionSignals: concept.recognitionSignals,
        misconceptionPatterns: concept.misconceptionPatterns,
        assessmentModes: concept.assessmentModes,
        related: concept.related ?? [],
        tags: concept.tags,
        conceptVersion: concept.version,
      })),
    );
    const prerequisites = curriculum.concepts.flatMap((concept) =>
      concept.prerequisites.map((prerequisiteId) => ({
        curriculumVersion: version,
        conceptId: concept.id,
        prerequisiteId,
      })),
    );
    if (prerequisites.length > 0) {
      await tx.insert(curriculumPrerequisites).values(prerequisites);
    }
    return { status: "imported", version, contentHash, conceptCount };
  });
}

export async function getLatestCurriculumVersion(db: Database): Promise<number | null> {
  const [row] = await db
    .select({ version: curriculumVersions.version })
    .from(curriculumVersions)
    .orderBy(desc(curriculumVersions.version))
    .limit(1);
  return row?.version ?? null;
}
