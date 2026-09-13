import { getCurriculum } from "@academy/curriculum";
import { databaseEnvSchema, parseEnv } from "@academy/shared";
import { createDatabase } from "../src/client";
import { importCurriculum } from "../src/curriculum-repository";

const env = parseEnv(databaseEnvSchema);
const { db, close } = createDatabase(env.DATABASE_URL, { maxConnections: 1 });
try {
  const result = await importCurriculum(db, getCurriculum().curriculum);
  console.log(
    `Curriculum v${result.version} ${result.status} (${result.conceptCount} concepts, ${result.contentHash.slice(0, 12)})`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
