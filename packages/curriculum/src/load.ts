import manifest from "../data/curriculum.json";
import db from "../data/db.json";
import dsa from "../data/dsa.json";
import fundamentals from "../data/fundamentals.json";
import reliability from "../data/reliability.json";
import security from "../data/security.json";
import systems from "../data/systems.json";
import web from "../data/web.json";
import { CurriculumGraph, validateCurriculum, type CurriculumIssue } from "./graph";
import { curriculumDomainFileSchema, curriculumSchema, type Curriculum } from "./schema";

/** Authored files, keyed by the name listed in data/curriculum.json. */
const AUTHORED_FILES: Record<string, unknown> = {
  "fundamentals.json": fundamentals,
  "dsa.json": dsa,
  "web.json": web,
  "db.json": db,
  "security.json": security,
  "reliability.json": reliability,
  "systems.json": systems,
};

export class CurriculumValidationError extends Error {
  constructor(public readonly issues: CurriculumIssue[]) {
    super(
      `Curriculum is invalid:\n${issues
        .map((issue) => `  - [${issue.code}] ${issue.conceptId ?? ""} ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "CurriculumValidationError";
  }
}

/** Assemble domain files into one curriculum, applying schema validation to each file. */
export function buildCurriculum(
  version: number,
  files: Array<{ name: string; data: unknown }>,
): Curriculum {
  const domains: Curriculum["domains"] = [];
  const concepts: Curriculum["concepts"] = [];
  for (const file of files) {
    const parsed = curriculumDomainFileSchema.safeParse(file.data);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`Curriculum file ${file.name} failed schema validation: ${detail}`);
    }
    domains.push(parsed.data.domain);
    concepts.push(...parsed.data.concepts);
  }
  return curriculumSchema.parse({ version, domains, concepts });
}

export interface LoadedCurriculum {
  curriculum: Curriculum;
  graph: CurriculumGraph;
  warnings: CurriculumIssue[];
}

export function loadSeedCurriculum(): LoadedCurriculum {
  const files = manifest.domainFiles.map((name) => {
    if (!(name in AUTHORED_FILES)) {
      throw new Error(`data/curriculum.json lists ${name}, but load.ts does not import it`);
    }
    return { name, data: AUTHORED_FILES[name] };
  });
  const curriculum = buildCurriculum(manifest.version, files);
  const issues = validateCurriculum(curriculum);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) throw new CurriculumValidationError(errors);
  return {
    curriculum,
    graph: new CurriculumGraph(curriculum),
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
}

let cached: LoadedCurriculum | undefined;

/** The validated, checked-in curriculum. Loaded once per process. */
export function getCurriculum(): LoadedCurriculum {
  cached ??= loadSeedCurriculum();
  return cached;
}
