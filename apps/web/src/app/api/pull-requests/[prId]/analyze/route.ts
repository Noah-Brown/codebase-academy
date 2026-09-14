import { createLogger } from "@academy/shared";
import { getCurrentUser } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { getGitHubApp } from "@/lib/github";
import { startAnalysis } from "@/lib/start-analysis";

export const dynamic = "force-dynamic";

const log = createLogger({ bindings: { route: "analyze-pull-request" } });

export async function POST(_request: Request, { params }: { params: Promise<{ prId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const db = getDatabase();
  const app = getGitHubApp();
  if (!db || !app) return Response.json({ error: "not_configured" }, { status: 503 });

  const { prId } = await params;
  const result = await startAnalysis(db, app, user.id, prId, log);
  return Response.json(result.body, { status: result.status });
}
