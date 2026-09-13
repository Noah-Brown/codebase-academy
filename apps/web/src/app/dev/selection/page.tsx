import { getCurriculum } from "@academy/curriculum";
import {
  MASTERY_LABEL_TEXT,
  STARTING_LEVELS,
  createLearnerView,
  selectLesson,
  type RankedCandidate,
  type StartingLevel,
} from "@academy/learning";
import { paymentRetryFixture } from "@academy/learning/fixtures";
import Link from "next/link";

export const metadata = { title: "Lesson selection demo · Codebase Academy" };

const TERM_LABELS: Record<string, string> = {
  prSignificance: "Importance to this PR",
  masteryGap: "Gap in your mastery",
  prerequisiteReadiness: "Prerequisites ready",
  novelty: "Novelty",
  operationalImportance: "Operational / security stakes",
};

function isLevel(value: string | undefined): value is StartingLevel {
  return STARTING_LEVELS.includes(value as StartingLevel);
}

function Breakdown({ candidate }: { candidate: RankedCandidate }) {
  const { components, weighted, basePriority, penalties, priority } = candidate.breakdown;
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
        {Object.entries(weighted).map(([term, value]) => (
          <tr key={term}>
            <td className="py-1.5 text-stone-600 dark:text-stone-400">{TERM_LABELS[term]}</td>
            <td className="py-1.5 text-right font-mono text-xs text-stone-500">
              {components[term as keyof typeof components].toFixed(2)}
            </td>
            <td className="py-1.5 text-right font-mono">+{value.toFixed(3)}</td>
          </tr>
        ))}
        <tr>
          <td className="py-1.5" colSpan={2}>
            Base priority
          </td>
          <td className="py-1.5 text-right font-mono">{basePriority.toFixed(3)}</td>
        </tr>
        {penalties.map((penalty) => (
          <tr key={penalty.code}>
            <td className="py-1.5 text-stone-600 dark:text-stone-400" colSpan={2}>
              Penalty: {penalty.code.replaceAll("_", " ")}
            </td>
            <td className="py-1.5 text-right font-mono">−{penalty.amount.toFixed(3)}</td>
          </tr>
        ))}
        <tr className="font-medium">
          <td className="py-1.5" colSpan={2}>
            Priority
          </td>
          <td className="py-1.5 text-right font-mono">{priority.toFixed(3)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default async function SelectionDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string }>;
}) {
  const { level: requested } = await searchParams;
  const level: StartingLevel = isLevel(requested) ? requested : "intermediate";
  const { graph } = getCurriculum();
  const fixture = paymentRetryFixture;
  const result = selectLesson({
    graph,
    learner: createLearnerView(level, graph, []),
    now: new Date(),
    mappings: fixture.mappings,
  });
  const selected = result.selected;

  return (
    <div className="space-y-8 pt-4">
      <p className="rounded-md border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400">
        Example data. The concept mappings below were written by hand; mapping from real pull
        requests comes in Milestone 3. Ranking, mastery labels, and explanations use the real
        learner model.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-stone-500">Starting level:</span>
        {STARTING_LEVELS.map((option) => (
          <Link
            key={option}
            href={`/dev/selection?level=${option}`}
            className={`rounded-full px-3 py-1 capitalize ${
              option === level
                ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                : "border border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
            }`}
          >
            {option}
          </Link>
        ))}
      </div>

      <section className="space-y-4 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{fixture.title}</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">{fixture.description}</p>
        </div>
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Touches
          </h2>
          <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {result.ranked.map((candidate) => (
              <li key={candidate.conceptId} className="flex justify-between gap-3">
                <span>{candidate.concept.title}</span>
                <span className="text-stone-500">{MASTERY_LABEL_TEXT[candidate.status.label]}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {selected ? (
        <section className="space-y-4 rounded-lg border-2 border-stone-900 p-5 dark:border-stone-100">
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Recommended lesson · {selected.depth}
            </div>
            <h2 className="text-lg font-semibold">{selected.concept.title}</h2>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Using <code className="font-mono text-xs">{selected.mapping.evidence[0]?.path}</code>{" "}
              from this PR
            </p>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {selected.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer text-stone-600 dark:text-stone-400">
              Why this ranking
            </summary>
            <div className="pt-3">
              <Breakdown candidate={selected} />
            </div>
          </details>
          <div className="flex flex-wrap gap-3 pt-1 text-sm">
            <span className="rounded-md bg-stone-200 px-4 py-2 text-stone-500 dark:bg-stone-800">
              Start lesson (Milestone 4)
            </span>
            <span className="px-1 py-2 text-stone-500">Or keep shipping. Nothing is blocked.</span>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-stone-200 p-5 text-sm dark:border-stone-800">
          This change doesn&apos;t map cleanly to the curriculum yet ({result.noSelectionReason}),
          so there&apos;s no lesson to recommend.
        </section>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-stone-600 dark:text-stone-400">
          Other concepts in this PR ({Math.max(result.ranked.length - 1, 0)})
        </summary>
        <ul className="space-y-4 pt-4">
          {result.ranked.slice(selected ? 1 : 0).map((candidate) => (
            <li
              key={candidate.conceptId}
              className="space-y-2 rounded-lg border border-stone-200 p-4 dark:border-stone-800"
            >
              <div className="flex justify-between gap-3">
                <span className="font-medium">{candidate.concept.title}</span>
                <span className="font-mono text-xs text-stone-500">
                  {candidate.breakdown.priority.toFixed(3)} · {candidate.depth}
                </span>
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-stone-600 dark:text-stone-400">
                {candidate.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
