"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ERRORS: Record<string, string> = {
  not_found: "This analysis is no longer available to you.",
  analysis_not_ready: "The pull request has not finished being read yet.",
  curriculum_not_imported: "The curriculum has not been imported. Run npm run curriculum:import.",
};

export function MapConceptsButton({ analysisId, label }: { analysisId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 dark:border-stone-700 dark:hover:bg-stone-900"
        onClick={async () => {
          setPending(true);
          setError(null);
          const response = await fetch(`/api/analyses/${analysisId}/concept-mapping`, {
            method: "POST",
          }).catch(() => null);
          const body = response ? await response.json().catch(() => ({})) : {};
          setPending(false);
          if (response?.ok) {
            router.refresh();
            return;
          }
          setError(ERRORS[body.error] ?? "Concept mapping could not be started. Try again.");
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
