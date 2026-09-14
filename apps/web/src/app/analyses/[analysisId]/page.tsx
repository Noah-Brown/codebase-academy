import { getAnalysisForUser } from "@academy/db";
import type { AnalysisContext } from "@academy/github";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase } from "@/lib/db";
import { requireOnboardedUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const SKIP_TEXT: Record<string, string> = {
  lockfile: "Lockfile",
  generated: "Generated or minified",
  vendored: "Vendored",
  binary: "Binary",
  too_large: "Too large",
  no_patch: "GitHub omitted the diff",
  budget: "Over the size budget",
};

const STATUS_TEXT: Record<string, string> = {
  queued: "Waiting for a worker to pick this up. Refresh in a moment.",
  running: "Reading the change now. Refresh in a moment.",
  failed: "The analysis failed. You can retry it from the repository page.",
  skipped: "This analysis was skipped because the pull request changed or closed.",
};

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const user = await requireOnboardedUser();
  const { analysisId } = await params;
  const access = await getAnalysisForUser(getDatabase()!, user.id, analysisId);
  if (!access) notFound();
  const { analysis, pullRequest, repository } = access;
  const context = analysis.status === "succeeded" ? (analysis.context as AnalysisContext) : null;

  return (
    <div className="space-y-6 pt-4">
      <header className="space-y-1">
        <Link
          href={`/repositories/${repository.id}`}
          className="text-sm text-stone-500 hover:underline"
        >
          ← {repository.fullName}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          #{pullRequest.number} {pullRequest.title}
        </h1>
        <p className="font-mono text-xs text-stone-500">
          {analysis.headSha.slice(0, 7)} · {analysis.analyzerVersion}
        </p>
      </header>

      {!context ? (
        <p
          role="status"
          className="rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-800"
        >
          {STATUS_TEXT[analysis.status] ?? analysis.status}
          {analysis.errorCode && (
            <span className="block pt-1 font-mono text-xs text-stone-500">
              {analysis.errorCode}
            </span>
          )}
        </p>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            {[
              ["Files included", context.files.filter((f) => f.included).length],
              ["Files skipped", context.files.filter((f) => !f.included).length],
              [
                "Estimated tokens",
                `${context.budget.estimatedTokens.toLocaleString()} / ${context.budget.maxTotalTokens.toLocaleString()}`,
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-stone-200 p-3 dark:border-stone-800"
              >
                <div className="text-xs text-stone-500">{label}</div>
                <div className="text-lg font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">Files</h2>
            <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm dark:divide-stone-800 dark:border-stone-800">
              {context.files.map((file) => (
                <li
                  key={file.path}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="min-w-0 break-all font-mono text-xs">{file.path}</span>
                  <span className="text-xs text-stone-500">
                    +{file.additions} −{file.deletions} ·{" "}
                    {file.included
                      ? `${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}${file.patchTruncated ? ", truncated" : ""}`
                      : (SKIP_TEXT[file.skipReason ?? ""] ?? "Skipped")}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <h2 className="font-semibold">Redacted before storage</h2>
              {Object.keys(context.redactions).length === 0 ? (
                <p className="text-sm text-stone-600 dark:text-stone-400">
                  Nothing looked like a secret.
                </p>
              ) : (
                <ul className="text-sm">
                  {Object.entries(context.redactions).map(([kind, count]) => (
                    <li key={kind}>
                      <span className="font-mono text-xs">{kind}</span>: {count}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-2">
              <h2 className="font-semibold">Project files read</h2>
              {context.manifests.length === 0 ? (
                <p className="text-sm text-stone-600 dark:text-stone-400">No manifests found.</p>
              ) : (
                <ul className="font-mono text-xs">
                  {context.manifests.map((m) => (
                    <li key={m.path}>{m.path}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {context.warnings.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-semibold">Warnings</h2>
              <ul className="font-mono text-xs text-stone-600 dark:text-stone-400">
                {context.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-stone-500">
            Concept mapping and lessons from this context arrive in the next milestones. Code is
            stored only as redacted, budgeted excerpts and is never shown to other users.
          </p>
        </>
      )}
    </div>
  );
}
