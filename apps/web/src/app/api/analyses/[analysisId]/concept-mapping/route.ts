import { getCurrentUser } from "@/lib/auth";
import { startConceptMapping } from "@/lib/concept-mapping";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Start or retry concept mapping for an analysis. Mapping runs in the worker; this only enqueues. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ analysisId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const db = getDatabase();
  if (!db) return Response.json({ error: "not_configured" }, { status: 503 });

  const { analysisId } = await params;
  const result = await startConceptMapping(db, user.id, analysisId);
  return Response.json(result.body, { status: result.status });
}
