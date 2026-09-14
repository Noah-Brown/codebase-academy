import { listRepositoriesForUser } from "@academy/db";
import Link from "next/link";
import { getWebEnv } from "@/lib/config";
import { getDatabase } from "@/lib/db";
import { requireOnboardedUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repositories · Codebase Academy" };

const MESSAGES: Record<string, string> = {
  installed: "GitHub connected. Your repositories are listed below.",
  not_authorized:
    "GitHub did not list that installation for your account, so it was not connected. Install the app from your own account, then try again.",
  github_unavailable: "GitHub could not be reached. Try connecting again in a moment.",
  sign_in_again: "Your GitHub sign-in expired. Sign out, sign in again, then connect GitHub.",
};

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireOnboardedUser();
  const { status } = await searchParams;
  const db = getDatabase()!;
  const env = getWebEnv();
  const repositories = await listRepositoriesForUser(db, user.id);
  const installUrl = env
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`
    : null;

  return (
    <div className="space-y-6 pt-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            Codebase Academy has read-only access to the repositories you choose on GitHub.
          </p>
        </div>
        {installUrl ? (
          <a
            href={installUrl}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
          >
            {repositories.length ? "Change repository access" : "Connect GitHub"}
          </a>
        ) : (
          <Link href="/setup" className="text-sm underline">
            GitHub App not configured
          </Link>
        )}
      </header>

      {status && MESSAGES[status] && (
        <p
          role="status"
          className="rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800"
        >
          {MESSAGES[status]}
        </p>
      )}

      {repositories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 p-6 text-sm text-stone-600 dark:border-stone-700 dark:text-stone-400">
          No repositories connected yet. Connect GitHub and pick one repository to start; you can
          add more later.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {repositories.map((repo) => (
            <li key={repo.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <Link href={`/repositories/${repo.id}`} className="font-medium hover:underline">
                {repo.fullName}
              </Link>
              <span className="flex items-center gap-2 text-xs text-stone-500">
                {repo.private && <span>Private</span>}
                {repo.installation.suspendedAt && (
                  <span className="text-amber-700 dark:text-amber-400">Access suspended</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
