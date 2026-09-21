import { getAnalysisForUser, type ConceptMappingView } from "@academy/db";
import type { AnalysisContext } from "@academy/github";
import {
  MASTERY_LABEL_TEXT,
  type LessonDepth,
  type RankedCandidate,
  type SelectionResult,
} from "@academy/learning";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeEvidence } from "@/components/code-evidence";
import { MapConceptsButton } from "@/components/map-concepts-button";
import { StartLessonButton } from "@/components/start-lesson-button";
import { getDatabase } from "@/lib/db";
import { loadLessonSelection } from "@/lib/lessons";
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

const DEPTH_TEXT: Record<LessonDepth, string> = {
  intro: "Introduction",
  applied: "Applied",
  advanced: "Advanced",
  defense: "Engineering defense",
};

const MAPPING_FAILURE_TEXT: Record<string, string> = {
  auth_failed:
    "The model provider rejected the worker's credentials. For the Claude CLI, run claude once on the worker's machine to sign in.",
  provider_unavailable:
    "The worker couldn't reach the model provider. For the Claude CLI, check that claude is installed and on the worker's PATH.",
  rate_limited: "The model provider's usage limit was reached. Try again later.",
  timeout: "The model took too long to answer.",
  invalid_output: "The model's answer didn't match the expected structure.",
  output_truncated: "The model's answer was cut off.",
  refused: "The model declined to analyze this change.",
  curriculum_version_mismatch: "The worker is running a different curriculum version. Restart it.",
  context_invalid: "The stored analysis couldn't be read. Analyze the pull request again.",
  analysis_not_ready: "The pull request hadn't finished being read.",
};

const panel = "rounded-lg border border-stone-200 p-5 text-sm dark:border-stone-800";

function MappingState({
  analysisId,
  view,
}: {
  analysisId: string;
  view: ConceptMappingView | null;
}) {
  if (!view) {
    return (
      <section className={`${panel} space-y-3`}>
        <p>This pull request hasn&apos;t been mapped to the curriculum yet.</p>
        <MapConceptsButton analysisId={analysisId} label="Map concepts" />
      </section>
    );
  }
  if (view.run.status === "queued" || view.run.status === "running") {
    return (
      <p role="status" className={panel}>
        Mapping this change to the curriculum. This usually takes under a minute; refresh to check.
      </p>
    );
  }
  return (
    <section className={`${panel} space-y-3`}>
      <p>
        {MAPPING_FAILURE_TEXT[view.run.errorCode ?? ""] ?? "Concept mapping failed."}
        <span className="block pt-1 font-mono text-xs text-stone-500">{view.run.errorCode}</span>
      </p>
      <MapConceptsButton analysisId={analysisId} label="Retry mapping" />
    </section>
  );
}

function Recommendation({
  analysisId,
  candidate,
}: {
  analysisId: string;
  candidate: RankedCandidate;
}) {
  return (
    <section className="space-y-4 rounded-lg border-2 border-stone-900 p-5 dark:border-stone-100">
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Recommended lesson · {DEPTH_TEXT[candidate.depth]}
        </div>
        <h2 className="text-lg font-semibold">{candidate.concept.title}</h2>
        <p className="text-sm text-stone-600 dark:text-stone-400">{candidate.concept.summary}</p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {candidate.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <CodeEvidence items={candidate.mapping.evidence} />
      <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
        <StartLessonButton
          analysisId={analysisId}
          conceptId={candidate.conceptId}
          label="Start lesson"
          primary
        />
        <span className="text-stone-500">Or keep shipping. Nothing is blocked.</span>
      </div>
    </section>
  );
}

function Concepts({
  analysisId,
  view,
  selection,
}: {
  analysisId: string;
  view: ConceptMappingView;
  selection: SelectionResult;
}) {
  const others = selection.ranked.filter((candidate) => candidate !== selection.selected);
  return (
    <>
      {selection.selected ? (
        <Recommendation analysisId={analysisId} candidate={selection.selected} />
      ) : (
        <p className={panel}>
          {view.mappings.length === 0
            ? "This change doesn't map cleanly to the curriculum yet, so there's no lesson to recommend. That's normal for small or mechanical changes."
            : "The concepts found in this change are too weakly evidenced to build a lesson on, so there's no lesson to recommend."}
        </p>
      )}

      {others.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">
            {selection.selected ? "Other concepts in this change" : "Concepts in this change"}
          </h2>
          <ul className="space-y-3">
            {others.map((candidate) => (
              <li
                key={candidate.conceptId}
                className="space-y-2 rounded-lg border border-stone-200 p-4 dark:border-stone-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{candidate.concept.title}</span>
                  <span className="text-xs text-stone-500">
                    {MASTERY_LABEL_TEXT[candidate.status.label]} · {DEPTH_TEXT[candidate.depth]}
                  </span>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-stone-600 dark:text-stone-400">
                    Why it&apos;s here
                  </summary>
                  <div className="space-y-3 pt-3">
                    <ul className="list-disc space-y-0.5 pl-5 text-stone-600 dark:text-stone-400">
                      {candidate.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    <CodeEvidence items={candidate.mapping.evidence} />
                    <StartLessonButton
                      analysisId={analysisId}
                      conceptId={candidate.conceptId}
                      label="Learn this instead"
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selection.excluded.length > 0 && (
        <p className="text-xs text-stone-500">
          {selection.excluded.length} mapped concept
          {selection.excluded.length === 1 ? " was" : "s were"} left out because the evidence was
          too weak to teach from.
        </p>
      )}
      <p className="font-mono text-xs text-stone-500">
        {view.run.model ?? view.run.provider} · {view.run.mapperVersion} · curriculum v
        {view.run.curriculumVersion}
      </p>
    </>
  );
}

function WhatWasRead({ context }: { context: AnalysisContext }) {
  return (
    <details className="space-y-4 text-sm">
      <summary className="cursor-pointer font-semibold">What was read</summary>
      <div className="space-y-6 pt-4">
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
          Code is stored only as redacted, budgeted excerpts and is never shown to other users.
        </p>
      </div>
    </details>
  );
}

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ analysisId: string }>;
}) {
  const user = await requireOnboardedUser();
  const { analysisId } = await params;
  const db = getDatabase()!;
  const access = await getAnalysisForUser(db, user.id, analysisId);
  if (!access) notFound();
  const { analysis, pullRequest, repository } = access;
  const context = analysis.status === "succeeded" ? (analysis.context as AnalysisContext) : null;
  const mapping = context ? await loadLessonSelection(db, user.id, analysis.id) : null;

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
        <p className="flex flex-wrap gap-x-3 font-mono text-xs text-stone-500">
          <span>
            {analysis.headSha.slice(0, 7)} · {analysis.analyzerVersion}
          </span>
          {context && (
            <a href={context.pullRequest.url} className="hover:underline">
              View on GitHub ↗
            </a>
          )}
        </p>
      </header>

      {!context || !mapping ? (
        <p role="status" className={panel}>
          {STATUS_TEXT[analysis.status] ?? analysis.status}
          {analysis.errorCode && (
            <span className="block pt-1 font-mono text-xs text-stone-500">
              {analysis.errorCode}
            </span>
          )}
        </p>
      ) : (
        <>
          {mapping.selection && mapping.view ? (
            <Concepts analysisId={analysis.id} view={mapping.view} selection={mapping.selection} />
          ) : (
            <MappingState analysisId={analysis.id} view={mapping.view} />
          )}
          <WhatWasRead context={context} />
        </>
      )}
    </div>
  );
}
