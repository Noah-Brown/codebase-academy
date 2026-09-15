/** Limits applied to concept-mapper output. Ranking thresholds live in @academy/learning. */
export interface ConceptMapperConfig {
  /** Mappings kept after validation, highest relevance × significance first. */
  maxMappings: number;
  maxEvidencePerMapping: number;
  /** An excerpt shorter than this (after whitespace collapsing) is too vague to count as evidence. */
  minExcerptChars: number;
  maxExcerptLines: number;
  maxExcerptChars: number;
  /** Longer rationales are cut at this length. */
  maxRationaleChars: number;
}

export const defaultConceptMapperConfig: Readonly<ConceptMapperConfig> = Object.freeze({
  maxMappings: 8,
  maxEvidencePerMapping: 3,
  minExcerptChars: 8,
  maxExcerptLines: 40,
  maxExcerptChars: 2_000,
  maxRationaleChars: 600,
});
