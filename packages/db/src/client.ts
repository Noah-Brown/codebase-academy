import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/** Driver-agnostic handle: postgres-js in the app and worker, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close(): Promise<void>;
}

export function createDatabase(
  url: string,
  options: { maxConnections?: number } = {},
): DatabaseHandle {
  const client = postgres(url, { max: options.maxConnections ?? 10, onnotice: () => {} });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}
