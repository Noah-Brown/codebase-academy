import { readJson, withUser } from "@/lib/api";
import { flagGrade } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** "This grade seems wrong": `{ note? }`. Kept for review; the grade is unchanged. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const { attemptId } = await params;
  const body = await readJson(request);
  return withUser((db, userId) => flagGrade(db, userId, attemptId, body));
}
