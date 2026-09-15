import type { CurriculumGraph } from "@academy/curriculum";
import type { AnalysisContext } from "@academy/github";
import type { MappedConcept } from "@academy/learning";
import { defaultConceptMapperConfig, type ConceptMapperConfig } from "./config";
import {
  LINE_NUMBER_PREFIX,
  excerptAppearsIn,
  groundingSources,
  lineRangeIsGrounded,
  normalizeLine,
} from "./grounding";
import type { MapperOutput } from "./schema";

export const DROP_REASONS = [
  "unknown_concept",
  "invalid_score",
  "duplicate_concept",
  "unknown_path",
  "invalid_excerpt",
  "excerpt_not_found",
  "missing_rationale",
  "no_valid_evidence",
  "evidence_over_limit",
  "over_limit",
  "line_numbers_removed",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];
/** How much model output validation discarded, by reason. Counts only, never content. */
export type DropCounts = Record<DropReason, number>;

export const emptyDropCounts = (): DropCounts =>
  Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as DropCounts;

export interface ValidatedMapping {
  mappings: MappedConcept[];
  dropped: DropCounts;
}

const isScore = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/** Removes blank lines at either end, and the prompt's `N| ` prefixes when every line carries one. */
function cleanExcerpt(excerpt: string): string {
  const lines = excerpt.split(/\r?\n/);
  while (lines.length > 0 && normalizeLine(lines[0]!) === "") lines.shift();
  while (lines.length > 0 && normalizeLine(lines.at(-1)!) === "") lines.pop();
  const content = lines.filter((line) => normalizeLine(line) !== "");
  const numbered = content.length > 0 && content.every((line) => LINE_NUMBER_PREFIX.test(line));
  return (numbered ? lines.map((line) => line.replace(LINE_NUMBER_PREFIX, "")) : lines).join("\n");
}

function excerptIsUsable(excerpt: string, config: ConceptMapperConfig): boolean {
  if (excerpt.length > config.maxExcerptChars) return false;
  if (excerpt.split(/\r?\n/).length > config.maxExcerptLines) return false;
  return normalizeLine(excerpt).length >= config.minExcerptChars;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Keep only mappings the curriculum and the pull request can back up. Unknown concept IDs, paths the
 * model was not shown, and excerpts that do not appear in the shown code are dropped individually;
 * a mapping left without evidence is dropped too. Line numbers that fall outside the shown ranges
 * are removed while the evidence is kept, since the excerpt is the traceable part.
 */
export function validateMapperOutput(
  output: MapperOutput,
  input: { context: AnalysisContext; graph: CurriculumGraph; config?: ConceptMapperConfig },
): ValidatedMapping {
  const config = input.config ?? defaultConceptMapperConfig;
  const sources = groundingSources(input.context);
  const dropped = emptyDropCounts();
  const accepted = new Map<string, MappedConcept>();

  for (const mapping of output.mappings) {
    if (!input.graph.has(mapping.conceptId)) {
      dropped.unknown_concept++;
      continue;
    }
    if (!isScore(mapping.relevance) || !isScore(mapping.significance)) {
      dropped.invalid_score++;
      continue;
    }
    if (accepted.has(mapping.conceptId)) {
      dropped.duplicate_concept++;
      continue;
    }

    const evidence: MappedConcept["evidence"] = [];
    for (const item of mapping.evidence) {
      const source = sources.get(item.path);
      if (!source) {
        dropped.unknown_path++;
        continue;
      }
      const excerpt = cleanExcerpt(item.excerpt);
      if (!excerptIsUsable(excerpt, config)) {
        dropped.invalid_excerpt++;
        continue;
      }
      if (!excerptAppearsIn(source, excerpt)) {
        dropped.excerpt_not_found++;
        continue;
      }
      const rationale = item.rationale.trim();
      if (rationale === "") {
        dropped.missing_rationale++;
        continue;
      }
      if (evidence.length >= config.maxEvidencePerMapping) {
        dropped.evidence_over_limit++;
        continue;
      }

      const cited: MappedConcept["evidence"][number] = {
        path: item.path,
        excerpt,
        rationale: truncate(rationale, config.maxRationaleChars),
      };
      if (item.startLine !== undefined || item.endLine !== undefined) {
        const startLine = item.startLine ?? item.endLine!;
        const endLine = item.endLine ?? startLine;
        if (lineRangeIsGrounded(source, startLine, endLine)) {
          cited.startLine = startLine;
          cited.endLine = endLine;
        } else {
          dropped.line_numbers_removed++;
        }
      }
      evidence.push(cited);
    }

    if (evidence.length === 0) {
      dropped.no_valid_evidence++;
      continue;
    }
    accepted.set(mapping.conceptId, {
      conceptId: mapping.conceptId,
      relevance: mapping.relevance,
      significance: mapping.significance,
      suggestedDepth: mapping.suggestedDepth,
      evidence,
    });
  }

  // Stable sort: ties keep the model's order.
  const ranked = [...accepted.values()].sort(
    (a, b) => b.relevance * b.significance - a.relevance * a.significance,
  );
  dropped.over_limit = Math.max(0, ranked.length - config.maxMappings);
  return { mappings: ranked.slice(0, config.maxMappings), dropped };
}
