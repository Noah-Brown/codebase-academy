/**
 * Background worker: boots, validates configuration, reaches Postgres, processes
 * queued jobs, and shuts down cleanly (finishing the job in flight).
 */
import { MAPPER_VERSION, createStructuredModel } from "@academy/ai";
import { getCurriculum } from "@academy/curriculum";
import {
  CONCEPT_MAPPING_QUEUE,
  createDatabase,
  createPgJobQueue,
  pingDatabase,
  scheduleConceptMapping,
} from "@academy/db";
import { createGitHubApp } from "@academy/github";
import {
  conceptMapperEnvSchema,
  createLogger,
  databaseEnvSchema,
  githubAppEnvSchema,
  invalidEnvKeys,
  parseEnv,
} from "@academy/shared";
import { createConceptMappingHandler } from "./concept-mapping";
import { PR_ANALYSIS_QUEUE, createPrAnalysisHandler } from "./pr-analysis";

const env = parseEnv(databaseEnvSchema);
const log = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker" } });

const { db, close } = createDatabase(env.DATABASE_URL, { maxConnections: 4 });

try {
  await pingDatabase(db);
} catch (error) {
  log.error("database unreachable", { error });
  await close();
  process.exit(1);
}

const queue = createPgJobQueue(db, { logger: log });
const registered: string[] = [];

// Concept mapping is set up first so pull request analysis knows whether to schedule it.
let onContextReady: ((analysisId: string) => Promise<void>) | undefined;
if (!process.env.CONCEPT_MAPPER_PROVIDER) {
  log.info("concept mapping disabled; set CONCEPT_MAPPER_PROVIDER to enable it");
} else {
  const missingMapper = invalidEnvKeys(conceptMapperEnvSchema);
  if (missingMapper.length > 0) {
    log.warn("concept mapper misconfigured; concept mapping is disabled", {
      missing: missingMapper,
    });
  } else {
    const mapper = parseEnv(conceptMapperEnvSchema);
    const { graph } = getCurriculum();
    const model = createStructuredModel({
      provider: mapper.CONCEPT_MAPPER_PROVIDER,
      model: mapper.CONCEPT_MAPPER_MODEL,
      effort: mapper.CONCEPT_MAPPER_EFFORT,
      timeoutMs: mapper.CONCEPT_MAPPER_TIMEOUT_MS,
      claudeCliPath: mapper.CLAUDE_CLI_PATH,
      anthropicApiKey: mapper.ANTHROPIC_API_KEY,
    });
    await queue.work(CONCEPT_MAPPING_QUEUE, createConceptMappingHandler({ db, model, graph, log }));
    registered.push(CONCEPT_MAPPING_QUEUE);
    onContextReady = async (analysisId) => {
      const result = await scheduleConceptMapping(db, {
        analysisId,
        mapperVersion: MAPPER_VERSION,
        curriculumVersion: graph.version,
      });
      if (result.status !== "scheduled" && result.status !== "existing") {
        log.warn("concept mapping not scheduled", { analysisId, reason: result.status });
      }
    };
    log.info("concept mapping enabled", {
      provider: mapper.CONCEPT_MAPPER_PROVIDER,
      model: mapper.CONCEPT_MAPPER_MODEL ?? "provider default",
      mapperVersion: MAPPER_VERSION,
      curriculumVersion: graph.version,
    });
  }
}

const missingGitHub = invalidEnvKeys(githubAppEnvSchema);
if (missingGitHub.length > 0) {
  log.warn("GitHub App not configured; pull request analysis is disabled", {
    missing: missingGitHub,
  });
} else {
  const github = parseEnv(githubAppEnvSchema);
  const app = createGitHubApp({
    appId: github.GITHUB_APP_ID,
    privateKey: github.GITHUB_APP_PRIVATE_KEY,
  });
  await queue.work(PR_ANALYSIS_QUEUE, createPrAnalysisHandler({ db, app, log, onContextReady }));
  registered.push(PR_ANALYSIS_QUEUE);
}

log.info("worker started", { queues: registered });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker stopping", { signal });
  await queue.stop();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
