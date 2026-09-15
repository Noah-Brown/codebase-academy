import { MAPPER_VERSION } from "@academy/ai/versions";
import { getCurriculum } from "@academy/curriculum";
import { scheduleConceptMappingForUser, type Database, type MappingVersions } from "@academy/db";

/** The mapper and curriculum versions this deployment reads and writes. */
export function currentMappingVersions(): MappingVersions {
  return { mapperVersion: MAPPER_VERSION, curriculumVersion: getCurriculum().graph.version };
}

export type StartConceptMappingResult =
  | { status: 202; body: { runId: string; status: string } }
  | { status: 404 | 409; body: { error: string } };

/**
 * Start (or return) concept mapping for one of the user's analyses. Idempotent, and a failed run is
 * retried at most once per failure however often this is called.
 */
export async function startConceptMapping(
  db: Database,
  userId: string,
  analysisId: string,
  versions: MappingVersions = currentMappingVersions(),
): Promise<StartConceptMappingResult> {
  const result = await scheduleConceptMappingForUser(db, { userId, analysisId, ...versions });
  switch (result.status) {
    case "scheduled":
    case "existing":
      return { status: 202, body: { runId: result.run.id, status: result.run.status } };
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    default:
      return { status: 409, body: { error: result.status } };
  }
}
