"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ERRORS: Record<string, string> = {
  not_found: "This pull request is no longer available to you.",
  installation_suspended: "GitHub access for this repository is suspended.",
  pull_request_closed: "This pull request is closed, so it was not analyzed.",
  github_unavailable: "GitHub could not be reached. Try again in a moment.",
};

export function AnalyzeButton({ pullRequestId, label }: { pullRequestId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 dark:border-stone-700 dark:hover:bg-stone-900"
        onClick={async () => {
          setPending(true);
          setError(null);
          const response = await fetch(`/api/pull-requests/${pullRequestId}/analyze`, {
            method: "POST",
          }).catch(() => null);
          const body = response ? await response.json().catch(() => ({})) : {};
          if (response?.ok && body.analysisId) {
            router.push(`/analyses/${body.analysisId}`);
            return;
          }
          setPending(false);
          setError(ERRORS[body.error] ?? "The analysis could not be started. Try again.");
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
