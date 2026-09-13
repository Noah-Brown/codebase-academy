import { createDatabase, type Database, type DatabaseHandle } from "@academy/db";

const globalForDb = globalThis as unknown as { academyDb?: DatabaseHandle };

/** Lazily created, process-wide database handle; null when DATABASE_URL is not configured. */
export function getDatabase(): Database | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalForDb.academyDb ??= createDatabase(url);
  return globalForDb.academyDb.db;
}
