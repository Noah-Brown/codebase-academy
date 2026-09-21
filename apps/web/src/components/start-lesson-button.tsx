"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ERRORS: Record<string, string> = {
  not_found: "This pull request is no longer available to you.",
  not_mapped: "This pull request hasn't been mapped to the curriculum yet.",
  concept_not_ranked:
    "This concept is no longer part of the pull request's mapping. Refresh the page.",
};

export function StartLessonButton({
  analysisId,
  conceptId,
  label,
  primary = false,
}: {
  analysisId: string;
  conceptId: string;
  label: string;
  primary?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={
          primary
            ? "rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300"
            : "rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 dark:border-stone-700 dark:hover:bg-stone-900"
        }
        onClick={async () => {
          setPending(true);
          setError(null);
          const response = await fetch(`/api/analyses/${analysisId}/lessons`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conceptId }),
          }).catch(() => null);
          const body = response ? await response.json().catch(() => ({})) : {};
          if (response?.ok && body.lessonId) {
            router.push(`/lessons/${body.lessonId}`);
            return;
          }
          setPending(false);
          setError(ERRORS[body.error] ?? "The lesson could not be started. Try again.");
        }}
      >
        {pending ? "Starting…" : label}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
