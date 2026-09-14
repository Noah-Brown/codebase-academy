import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { migrationsFolder } from "./testing";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of the migrations folder truncated to the first `count` journal entries. */
async function migrationsUpTo(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "academy-migrations-"));
  dirs.push(dir);
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe("0003_github_ingestion", () => {
  it("upgrades existing users to Better Auth's shape", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: await migrationsUpTo(3) });
      await client.exec(`
        insert into users (id, name, email, email_verified) values
          ('verified', 'Ada', 'ada@example.test', now()),
          ('unverified', null, 'bob@example.test', null);
      `);

      await migrate(db, { migrationsFolder });

      const { rows } = await client.query<{ id: string; name: string; email_verified: boolean }>(
        "select id, name, email_verified from users order by id",
      );
      expect(rows).toEqual([
        { id: "unverified", name: "", email_verified: false },
        { id: "verified", name: "Ada", email_verified: true },
      ]);
      await client.exec(
        `insert into users (id, name, email) values ('fresh', 'Cy', 'cy@example.test')`,
      );
      const fresh = await client.query<{ email_verified: boolean }>(
        "select email_verified from users where id = 'fresh'",
      );
      expect(fresh.rows[0]?.email_verified).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);
});
