/**
 * Background worker: boots, validates configuration, reaches Postgres, processes
 * queued jobs, and shuts down cleanly (finishing the job in flight).
 */
import { createDatabase, createPgJobQueue, pingDatabase } from "@academy/db";
import { createGitHubApp } from "@academy/github";
import {
  createLogger,
  databaseEnvSchema,
  githubAppEnvSchema,
  invalidEnvKeys,
  parseEnv,
} from "@academy/shared";
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
  await queue.work(PR_ANALYSIS_QUEUE, createPrAnalysisHandler({ db, app, log }));
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
