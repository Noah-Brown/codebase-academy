import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database, DatabaseHandle } from "./client";
import * as schema from "./schema";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * In-process Postgres (PGlite) with all migrations applied — real Postgres
 * semantics for constraints, triggers, and transactions, with no server.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Database, close: () => client.close() };
}
