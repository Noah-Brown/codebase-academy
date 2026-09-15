import type { MappedConcept } from "@academy/learning";
import type { GoldenFixture } from "./fixtures";

export interface GoldenScore {
  passed: boolean;
  conceptIds: string[];
  missingRequired: string[];
  /** Mapped concepts outside required ∪ allowed. */
  unexpected: string[];
  forbidden: string[];
  /** Required concepts mapped below the ranker's minimum relevance, so they could never be taught. */
  weakRequired: string[];
  /** Evidence paths that are not included files or manifests of the fixture. */
  invalidPaths: string[];
}

/**
 * Score validated mappings against a golden fixture. Wording is free; concept IDs, evidence paths,
 * and minimum relevance are enforced.
 */
export function scoreGolden(
  fixture: GoldenFixture,
  mappings: MappedConcept[],
  minRelevance: number,
): GoldenScore {
  const { required, allowed, forbidden } = fixture.expected;
  const conceptIds = mappings.map((mapping) => mapping.conceptId);
  const permitted = new Set([...required, ...allowed]);
  const shownPaths = new Set([
    ...fixture.context.files.filter((file) => file.included).map((file) => file.path),
    ...fixture.context.manifests.map((manifest) => manifest.path),
  ]);

  const score: Omit<GoldenScore, "passed"> = {
    conceptIds,
    missingRequired: required.filter((id) => !conceptIds.includes(id)),
    unexpected: conceptIds.filter((id) => !permitted.has(id)),
    forbidden: conceptIds.filter((id) => forbidden.includes(id)),
    weakRequired: mappings
      .filter((mapping) => required.includes(mapping.conceptId) && mapping.relevance < minRelevance)
      .map((mapping) => mapping.conceptId),
    invalidPaths: mappings.flatMap((mapping) =>
      mapping.evidence.filter((item) => !shownPaths.has(item.path)).map((item) => item.path),
    ),
  };
  return {
    ...score,
    passed:
      score.missingRequired.length === 0 &&
      score.unexpected.length === 0 &&
      score.forbidden.length === 0 &&
      score.weakRequired.length === 0 &&
      score.invalidPaths.length === 0,
  };
}
