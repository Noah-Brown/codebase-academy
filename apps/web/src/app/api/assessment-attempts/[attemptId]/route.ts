import { withUser } from "@/lib/api";
import { attemptStatus } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Grading status and, once graded, the revealed result. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const { attemptId } = await params;
  return withUser((db, userId) => attemptStatus(db, userId, attemptId));
}
