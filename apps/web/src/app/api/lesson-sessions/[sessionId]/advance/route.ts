import { readJson, withUser } from "@/lib/api";
import { advanceLesson } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Move past the current step: `{ fromStep }`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await readJson(request);
  return withUser((db, userId) => advanceLesson(db, userId, sessionId, body));
}
