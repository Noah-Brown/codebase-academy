import { withUser } from "@/lib/api";
import { lessonStatus } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Generation status, polled while a lesson is being prepared. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lessonId: string }> },
) {
  const { lessonId } = await params;
  return withUser((db, userId) => lessonStatus(db, userId, lessonId));
}
