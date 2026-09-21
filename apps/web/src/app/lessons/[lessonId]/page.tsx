import Link from "next/link";
import { notFound } from "next/navigation";
import { LessonPlayer } from "@/components/lesson-player";
import { LessonPreparing } from "@/components/lesson-preparing";
import { getDatabase } from "@/lib/db";
import { loadLessonView } from "@/lib/lessons";
import { requireOnboardedUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const user = await requireOnboardedUser();
  const { lessonId } = await params;
  const view = await loadLessonView(getDatabase()!, user.id, lessonId);
  if (!view) notFound();

  return (
    <div className="space-y-6 pt-4">
      <header className="space-y-1">
        <Link
          href={`/analyses/${view.analysisId}`}
          className="text-sm text-stone-500 hover:underline"
        >
          ← #{view.pullRequestNumber} {view.pullRequestTitle}
        </Link>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Lesson on <span className="font-medium">{view.conceptTitle}</span> ·{" "}
          {view.repositoryFullName}
        </p>
      </header>
      {view.status === "ready" ? <LessonPlayer view={view} /> : <LessonPreparing view={view} />}
    </div>
  );
}
