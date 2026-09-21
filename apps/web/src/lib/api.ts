import type { Database } from "@academy/db";
import { getCurrentUser } from "./auth";
import { getDatabase } from "./db";

/** Runs a route body for the signed-in user; every repository-derived read inside is user-scoped. */
export async function withUser(
  run: (db: Database, userId: string) => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const db = getDatabase();
  if (!db) return Response.json({ error: "not_configured" }, { status: 503 });
  const result = await run(db, user.id);
  return Response.json(result.body, { status: result.status });
}

/** The request's JSON body, or null when it is missing or malformed (validated by the caller). */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
