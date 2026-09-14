import { getRepositoryForUser, listPullRequestsForUser } from "@academy/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalyzeButton } from "@/components/analyze-button";
import { getDatabase } from "@/lib/db";
import { requireOnboardedUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  running: "Analyzing",
  succeeded: "Analyzed",
  failed: "Analysis failed",
  skipped: "Skipped",
};

export default async function RepositoryPage({ params }: { params: Promise<{ repoId: string }> }) {
  const user = await requireOnboardedUser();
  const { repoId } = await params;
  const db = getDatabase()!;
  const repository = await getRepositoryForUser(db, user.id, Number(repoId));
  if (!repository) notFound();
  const pullRequests = await listPullRequestsForUser(db, user.id, repository.id, { state: "open" });

  return (
    <div className="space-y-6 pt-4">
      <header className="space-y-1">
        <Link href="/repositories" className="text-sm text-stone-500 hover:underline">
          ← Repositories
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{repository.fullName}</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Open pull requests. Analysis reads the change and nearby code; it never comments on or
          blocks the pull request.
        </p>
      </header>

      {pullRequests.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 p-6 text-sm text-stone-600 dark:border-stone-700 dark:text-stone-400">
          No open pull requests have been seen yet. New and updated pull requests appear here
          automatically once GitHub sends them.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {pullRequests.map((pr) => {
            const analysis = pr.latestAnalysis;
            return (
              <li
                key={pr.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">
                    <span className="text-stone-500">#{pr.number}</span> {pr.title}
                  </p>
                  <p className="font-mono text-xs text-stone-500">
                    {pr.headRef} → {pr.baseRef} · {pr.headSha.slice(0, 7)} · @{pr.authorLogin}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {analysis && (
                    <Link href={`/analyses/${analysis.id}`} className="text-sm hover:underline">
                      {STATUS_TEXT[analysis.status] ?? analysis.status}
                    </Link>
                  )}
                  {(!analysis || analysis.status === "failed") && (
                    <AnalyzeButton
                      pullRequestId={pr.id}
                      label={analysis ? "Retry analysis" : "Analyze"}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
