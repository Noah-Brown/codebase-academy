import { getCurriculum } from "@academy/curriculum";
import { initializeLearner, schema } from "@academy/db";
import { STARTING_LEVELS, type StartingLevel } from "@academy/learning";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { SignInButton } from "@/components/auth-buttons";
import { getCurrentUser } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Get started · Codebase Academy" };

const LEVEL_TEXT: Record<StartingLevel, { title: string; detail: string }> = {
  novice: {
    title: "Novice",
    detail: "Familiar with code; wants foundations explained before being questioned.",
  },
  intermediate: {
    title: "Intermediate",
    detail: "Builds applications; wants more depth and better engineering judgment.",
  },
  advanced: {
    title: "Advanced",
    detail: "Wants rigorous questions on architecture, failure modes, and security.",
  },
};

async function chooseLevel(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  const db = getDatabase();
  const level = formData.get("level");
  if (!user || !db) redirect("/onboarding");
  if (!STARTING_LEVELS.includes(level as StartingLevel)) redirect("/onboarding?error=level");
  // Existing learner states are never reset, so choosing again cannot erase evidence.
  await initializeLearner(db, {
    userId: user.id,
    level: level as StartingLevel,
    graph: getCurriculum().graph,
  });
  redirect("/repositories");
}

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="space-y-4 pt-4">
        <h1 className="text-2xl font-semibold tracking-tight">Get started</h1>
        <p className="text-stone-600 dark:text-stone-400">
          Sign in with GitHub to connect a repository. Codebase Academy only asks for read access to
          the repositories you choose.
        </p>
        <SignInButton callbackURL="/onboarding" />
      </div>
    );
  }

  const db = getDatabase();
  const [row] = db
    ? await db
        .select({ startingLevel: schema.users.startingLevel })
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
    : [];

  return (
    <form action={chooseLevel} className="space-y-6 pt-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Where should lessons start?</h1>
        <p className="text-stone-600 dark:text-stone-400">
          This only sets where lessons begin. After that, the answers you give decide what comes
          next. You can change it later without losing progress.
        </p>
      </header>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Starting level</legend>
        {STARTING_LEVELS.map((level) => (
          <label
            key={level}
            className="flex cursor-pointer flex-col gap-1 rounded-lg border border-stone-200 p-4 has-[:checked]:border-stone-900 dark:border-stone-800 dark:has-[:checked]:border-stone-100"
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="level"
                value={level}
                defaultChecked={(row?.startingLevel ?? "intermediate") === level}
                required
              />
              {LEVEL_TEXT[level].title}
            </span>
            <span className="text-sm text-stone-600 dark:text-stone-400">
              {LEVEL_TEXT[level].detail}
            </span>
          </label>
        ))}
      </fieldset>
      <button
        type="submit"
        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
      >
        Continue
      </button>
    </form>
  );
}
