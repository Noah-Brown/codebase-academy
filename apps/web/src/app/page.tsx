import Link from "next/link";

const levels = [
  {
    name: "Novice",
    detail: "Familiar with code, wants foundations explained before being questioned.",
  },
  {
    name: "Intermediate",
    detail: "Builds applications; wants more depth and better engineering judgment.",
  },
  {
    name: "Advanced",
    detail: "Wants rigorous questions on architecture, failure modes, and security.",
  },
];

const steps = [
  "Connect a repository and pick an open pull request.",
  "We map the change to concepts in a structured engineering curriculum.",
  "You get one short lesson, pitched to what you have actually demonstrated.",
];

export default function Home() {
  return (
    <div className="space-y-14">
      <section className="space-y-5 pt-8">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Understand the code you ship, including the parts AI wrote.
        </h1>
        <p className="max-w-2xl text-lg text-stone-600 dark:text-stone-400">
          Codebase Academy turns your pull requests into short lessons from a real software
          engineering curriculum. The lessons start at your level and use your own code as the
          examples.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/dev/selection"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
          >
            See a lesson recommendation
          </Link>
          <Link
            href="/curriculum"
            className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
          >
            Browse the skill map
          </Link>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          How it works
        </h2>
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-4">
              <span className="font-mono text-sm text-stone-400">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Choose where to start
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Your starting level only sets where lessons begin. After that, the answers you give decide
          what comes next.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {levels.map((level) => (
            <div
              key={level.name}
              className="rounded-lg border border-stone-200 p-4 dark:border-stone-800"
            >
              <div className="font-medium">{level.name}</div>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{level.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
