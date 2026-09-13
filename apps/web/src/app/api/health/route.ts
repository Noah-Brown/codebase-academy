import { pingDatabase } from "@academy/db";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDatabase();
  if (!db) return Response.json({ status: "ok", database: "unconfigured" });
  try {
    await pingDatabase(db);
    return Response.json({ status: "ok", database: "ok" });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
