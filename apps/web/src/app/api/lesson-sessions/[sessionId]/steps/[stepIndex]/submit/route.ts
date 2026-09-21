import { readJson, withUser } from "@/lib/api";
import { submitStep } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Answer an assessment step: `{ choiceId }`, `{ text }`, or `{ dontKnow: true }`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; stepIndex: string }> },
) {
  const { sessionId, stepIndex } = await params;
  const body = await readJson(request);
  return withUser((db, userId) => submitStep(db, userId, sessionId, Number(stepIndex), body));
}
