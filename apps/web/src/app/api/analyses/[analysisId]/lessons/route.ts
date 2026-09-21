import { readJson, withUser } from "@/lib/api";
import { startLesson } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Request a lesson on a mapped concept; generation runs in the worker. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ analysisId: string }> },
) {
  const { analysisId } = await params;
  const body = await readJson(request);
  return withUser((db, userId) => startLesson(db, userId, analysisId, body));
}
