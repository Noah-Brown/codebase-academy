/**
 * Background worker. Milestone 0 proves the process boots, validates its
 * configuration, reaches Postgres, and shuts down cleanly. PR analysis and
 * lesson-generation handlers register here from Milestone 2 onward.
 */
import { createDatabase, pingDatabase } from "@academy/db";
import { createLogger, databaseEnvSchema, parseEnv, type JobHandler } from "@academy/shared";

const env = parseEnv(databaseEnvSchema);
const log = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker" } });

const handlers: Record<string, JobHandler<unknown>> = {};

const { db, close } = createDatabase(env.DATABASE_URL, { maxConnections: 2 });

try {
  await pingDatabase(db);
} catch (error) {
  log.error("database unreachable", { error });
  await close();
  process.exit(1);
}

log.info("worker started", { jobs: Object.keys(handlers) });

const heartbeat = setInterval(() => log.debug("heartbeat"), 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker stopping", { signal });
  clearInterval(heartbeat);
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
