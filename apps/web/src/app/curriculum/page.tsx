import { getCurriculum } from "@academy/curriculum";

export const metadata = { title: "Skill map · Codebase Academy" };

function Difficulty({ level }: { level: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`Difficulty ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-1.5 w-1.5 rounded-full ${n <= level ? "bg-stone-700 dark:bg-stone-300" : "bg-stone-200 dark:bg-stone-800"}`}
        />
      ))}
    </span>
  );
}

export default function CurriculumPage() {
  const { curriculum, graph } = getCurriculum();
  const domains = [...curriculum.domains].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-10">
      <header className="space-y-2 pt-4">
        <h1 className="text-2xl font-semibold tracking-tight">Skill map</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Curriculum v{curriculum.version}: {curriculum.concepts.length} concepts across{" "}
          {domains.length} domains. Your status on each concept will show here after you sign in.
        </p>
      </header>

      {domains.map((domain) => (
        <section key={domain.id} className="space-y-3">
          <div>
            <h2 className="font-semibold">{domain.title}</h2>
            <p className="text-sm text-stone-600 dark:text-stone-400">{domain.summary}</p>
          </div>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {graph.conceptsInDomain(domain.id).map((concept) => (
              <li key={concept.id} className="space-y-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{concept.title}</span>
                  <span className="flex items-center gap-3">
                    {concept.operationalImportance >= 0.8 && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        High stakes
                      </span>
                    )}
                    <Difficulty level={concept.difficulty} />
                  </span>
                </div>
                <p className="text-sm text-stone-600 dark:text-stone-400">{concept.summary}</p>
                {concept.prerequisites.length > 0 && (
                  <p className="text-xs text-stone-500">
                    Builds on{" "}
                    {graph
                      .directPrerequisites(concept.id)
                      .map((p) => p.title)
                      .join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
