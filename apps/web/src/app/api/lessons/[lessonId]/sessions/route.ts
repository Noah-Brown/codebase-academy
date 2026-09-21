import { withUser } from "@/lib/api";
import { beginLesson } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Begin a ready lesson, or resume its active session. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ lessonId: string }> },
) {
  const { lessonId } = await params;
  return withUser((db, userId) => beginLesson(db, userId, lessonId));
}
