import { missingConfiguration } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup · Codebase Academy" };

function Group({ title, missing, help }: { title: string; missing: string[]; help: string }) {
  const ready = missing.length === 0;
  return (
    <section className="space-y-2 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            ready
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          {ready ? "Configured" : "Needs setup"}
        </span>
      </div>
      {!ready && (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Missing or invalid: <code className="font-mono text-xs">{missing.join(", ")}</code>
        </p>
      )}
      <p className="text-sm text-stone-600 dark:text-stone-400">{help}</p>
    </section>
  );
}

export default function SetupPage() {
  const missing = missingConfiguration();
  return (
    <div className="space-y-6 pt-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Settings are read from the <code className="font-mono text-xs">.env</code> file at the
          repository root. This page lists names only, never values. Restart the dev server after
          changing them.
        </p>
      </header>
      <Group
        title="Database"
        missing={missing.database ? ["DATABASE_URL"] : []}
        help="Run npm run db:up (or point DATABASE_URL at Postgres 16+), then npm run db:migrate and npm run curriculum:import."
      />
      <Group
        title="Sign-in with GitHub"
        missing={missing.auth}
        help="Use the GitHub App's Client ID and a generated client secret. Callback URL: <APP_BASE_URL>/api/auth/callback/github."
      />
      <Group
        title="GitHub App"
        missing={missing.githubApp}
        help="App ID, slug, a generated private key, and the webhook secret. Permissions: metadata, contents, and pull requests (read-only); email addresses (read-only)."
      />
      <Group
        title="Concept mapping (worker)"
        missing={missing.conceptMapper}
        help="Set CONCEPT_MAPPER_PROVIDER=claude-cli to map concepts with your own signed-in Claude Code (every tool disabled), or anthropic with ANTHROPIC_API_KEY. Restart the worker after changing it."
      />
    </div>
  );
}
