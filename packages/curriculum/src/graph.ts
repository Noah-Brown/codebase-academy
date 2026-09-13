import type { Curriculum, CurriculumConcept, CurriculumDomain } from "./schema";

export type CurriculumIssueCode =
  | "duplicate_domain_id"
  | "duplicate_concept_id"
  | "unknown_domain"
  | "domain_prefix_mismatch"
  | "missing_prerequisite"
  | "self_prerequisite"
  | "duplicate_prerequisite"
  | "prerequisite_cycle"
  | "concept_version_ahead"
  | "empty_domain"
  | "prerequisite_harder_than_concept"
  | "redundant_transitive_prerequisite"
  | "missing_related"
  | "self_related"
  | "duplicate_related"
  | "related_is_prerequisite";

export interface CurriculumIssue {
  severity: "error" | "warning";
  code: CurriculumIssueCode;
  message: string;
  conceptId?: string;
}

/**
 * Structural validation beyond the Zod schema: identity, references, and the
 * prerequisite graph. Errors block import; warnings are surfaced for authors.
 */
export function validateCurriculum(curriculum: Curriculum): CurriculumIssue[] {
  const issues: CurriculumIssue[] = [];
  const error = (code: CurriculumIssueCode, message: string, conceptId?: string) =>
    issues.push({ severity: "error", code, message, conceptId });
  const warning = (code: CurriculumIssueCode, message: string, conceptId?: string) =>
    issues.push({ severity: "warning", code, message, conceptId });

  const domainIds = new Set<string>();
  for (const domain of curriculum.domains) {
    if (domainIds.has(domain.id)) error("duplicate_domain_id", `Duplicate domain "${domain.id}"`);
    domainIds.add(domain.id);
  }

  const byId = new Map<string, CurriculumConcept>();
  for (const concept of curriculum.concepts) {
    if (byId.has(concept.id)) {
      error("duplicate_concept_id", `Duplicate concept "${concept.id}"`, concept.id);
      continue;
    }
    byId.set(concept.id, concept);
  }

  for (const concept of byId.values()) {
    if (!domainIds.has(concept.domain)) {
      error("unknown_domain", `Unknown domain "${concept.domain}"`, concept.id);
    }
    if (concept.id.split(".")[0] !== concept.domain) {
      error(
        "domain_prefix_mismatch",
        `Concept ID prefix does not match domain "${concept.domain}"`,
        concept.id,
      );
    }
    if (concept.version > curriculum.version) {
      error(
        "concept_version_ahead",
        `Concept version ${concept.version} exceeds curriculum version ${curriculum.version}`,
        concept.id,
      );
    }

    const seen = new Set<string>();
    for (const prerequisiteId of concept.prerequisites) {
      if (seen.has(prerequisiteId)) {
        error(
          "duplicate_prerequisite",
          `Prerequisite "${prerequisiteId}" listed twice`,
          concept.id,
        );
      }
      seen.add(prerequisiteId);

      if (prerequisiteId === concept.id) {
        error("self_prerequisite", "Concept lists itself as a prerequisite", concept.id);
        continue;
      }
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) {
        error("missing_prerequisite", `Unknown prerequisite "${prerequisiteId}"`, concept.id);
      } else if (prerequisite.difficulty > concept.difficulty) {
        warning(
          "prerequisite_harder_than_concept",
          `Prerequisite "${prerequisiteId}" (difficulty ${prerequisite.difficulty}) is harder than this concept (${concept.difficulty})`,
          concept.id,
        );
      }
    }
  }

  for (const concept of byId.values()) {
    const seenRelated = new Set<string>();
    for (const { id: relatedId } of concept.related ?? []) {
      if (seenRelated.has(relatedId)) {
        error("duplicate_related", `Related concept "${relatedId}" listed twice`, concept.id);
      }
      seenRelated.add(relatedId);
      if (relatedId === concept.id) {
        error("self_related", "Concept lists itself as related", concept.id);
      } else if (!byId.has(relatedId)) {
        error("missing_related", `Unknown related concept "${relatedId}"`, concept.id);
      } else if (concept.prerequisites.includes(relatedId)) {
        warning(
          "related_is_prerequisite",
          `"${relatedId}" is already a prerequisite; list it in one place only`,
          concept.id,
        );
      }
    }
  }

  const cycles = findPrerequisiteCycles(byId);
  for (const cycle of cycles) {
    error("prerequisite_cycle", `Prerequisite cycle: ${cycle.join(" -> ")}`, cycle[0]);
  }

  // The ranker averages readiness over DIRECT prerequisites only, so an edge that is
  // already implied through another prerequisite silently re-weights a concept.
  if (cycles.length === 0) {
    const closure = new Map<string, Set<string>>();
    const reach = (id: string): Set<string> => {
      const cached = closure.get(id);
      if (cached) return cached;
      const result = new Set<string>();
      closure.set(id, result);
      for (const next of byId.get(id)?.prerequisites ?? []) {
        if (!byId.has(next) || next === id) continue;
        result.add(next);
        for (const deeper of reach(next)) result.add(deeper);
      }
      return result;
    };
    for (const concept of byId.values()) {
      for (const prerequisiteId of concept.prerequisites) {
        const via = concept.prerequisites.find(
          (other) =>
            other !== prerequisiteId && byId.has(other) && reach(other).has(prerequisiteId),
        );
        if (via) {
          warning(
            "redundant_transitive_prerequisite",
            `Prerequisite "${prerequisiteId}" is already implied through "${via}"`,
            concept.id,
          );
        }
      }
    }
  }

  for (const domainId of domainIds) {
    if (![...byId.values()].some((concept) => concept.domain === domainId)) {
      warning("empty_domain", `Domain "${domainId}" has no concepts`);
    }
  }

  return issues;
}

/** Depth-first search for back edges; each reported cycle starts and ends on the same ID. */
function findPrerequisiteCycles(byId: Map<string, CurriculumConcept>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string) => {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of byId.get(id)?.prerequisites ?? []) {
      if (next === id || !byId.has(next)) continue;
      const nextState = state.get(next);
      if (nextState === "visiting") {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const id of [...byId.keys()].sort()) {
    if (!state.has(id)) visit(id);
  }
  return cycles;
}

export class CurriculumGraph {
  private readonly byId: Map<string, CurriculumConcept>;
  private readonly dependents: Map<string, string[]>;

  constructor(public readonly curriculum: Curriculum) {
    this.byId = new Map(curriculum.concepts.map((concept) => [concept.id, concept]));
    this.dependents = new Map();
    for (const concept of curriculum.concepts) {
      for (const prerequisiteId of concept.prerequisites) {
        const list = this.dependents.get(prerequisiteId) ?? [];
        list.push(concept.id);
        this.dependents.set(prerequisiteId, list);
      }
    }
  }

  get version(): number {
    return this.curriculum.version;
  }

  has(conceptId: string): boolean {
    return this.byId.has(conceptId);
  }

  get(conceptId: string): CurriculumConcept | undefined {
    return this.byId.get(conceptId);
  }

  require(conceptId: string): CurriculumConcept {
    const concept = this.byId.get(conceptId);
    if (!concept) throw new Error(`Unknown curriculum concept "${conceptId}"`);
    return concept;
  }

  domain(domainId: string): CurriculumDomain | undefined {
    return this.curriculum.domains.find((domain) => domain.id === domainId);
  }

  conceptsInDomain(domainId: string): CurriculumConcept[] {
    return this.curriculum.concepts.filter((concept) => concept.domain === domainId);
  }

  directPrerequisites(conceptId: string): CurriculumConcept[] {
    return this.require(conceptId).prerequisites.map((id) => this.require(id));
  }

  /** Concepts that list this one as a direct prerequisite. */
  directDependents(conceptId: string): CurriculumConcept[] {
    return (this.dependents.get(conceptId) ?? []).map((id) => this.require(id));
  }

  /** Transitive prerequisites, nearest first (breadth-first), without duplicates. */
  allPrerequisites(conceptId: string): CurriculumConcept[] {
    const seen = new Set<string>();
    const queue = [...this.require(conceptId).prerequisites];
    const result: CurriculumConcept[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const concept = this.require(id);
      result.push(concept);
      queue.push(...concept.prerequisites);
    }
    return result;
  }

  /** Deterministic topological order: every concept appears after all its prerequisites. */
  topologicalOrder(): CurriculumConcept[] {
    const remaining = new Map(
      this.curriculum.concepts.map((concept) => [concept.id, concept.prerequisites.length]),
    );
    const ready = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort();
    const order: CurriculumConcept[] = [];

    while (ready.length > 0) {
      const id = ready.shift()!;
      order.push(this.require(id));
      for (const dependentId of this.dependents.get(id) ?? []) {
        const count = remaining.get(dependentId)! - 1;
        remaining.set(dependentId, count);
        if (count === 0) {
          ready.push(dependentId);
          ready.sort();
        }
      }
    }

    if (order.length !== this.curriculum.concepts.length) {
      throw new Error("Curriculum prerequisite graph contains a cycle");
    }
    return order;
  }
}
