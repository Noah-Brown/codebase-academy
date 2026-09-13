import { databaseEnvSchema, parseEnv } from "@academy/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { migrationsFolder } from "../src/testing";

const env = parseEnv(databaseEnvSchema);
const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log("Migrations applied.");
} finally {
  await client.end();
}
