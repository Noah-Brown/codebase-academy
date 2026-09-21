"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { PendingLessonView } from "@/lib/lesson-view";
import { StartLessonButton } from "./start-lesson-button";

const FAILURE_TEXT: Record<string, string> = {
  auth_failed:
    "The model provider rejected the worker's credentials. For the Claude CLI, run claude once on the worker's machine to sign in.",
  provider_unavailable: "The worker couldn't reach the model provider.",
  rate_limited: "The model provider's usage limit was reached. Try again later.",
  timeout: "Writing the lesson took too long.",
  invalid_output: "The generated lesson didn't pass its structure checks.",
  curriculum_version_mismatch: "The worker is running a different curriculum version. Restart it.",
};

/** Shown while the worker writes the lesson; checks back every few seconds. */
export function LessonPreparing({ view }: { view: PendingLessonView }) {
  const router = useRouter();

  useEffect(() => {
    if (view.status === "failed") return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/lessons/${view.lessonId}`).catch(() => null);
      const body = response?.ok ? await response.json().catch(() => null) : null;
      if (body && body.status !== view.status) router.refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [router, view.lessonId, view.status]);

  if (view.status === "failed") {
    return (
      <section className="space-y-3 rounded-lg border border-stone-200 p-5 text-sm dark:border-stone-800">
        <p>
          {FAILURE_TEXT[view.errorCode ?? ""] ?? "This lesson couldn't be prepared."}
          {view.errorCode && (
            <span className="block pt-1 font-mono text-xs text-stone-500">{view.errorCode}</span>
          )}
        </p>
        <StartLessonButton
          analysisId={view.analysisId}
          conceptId={view.conceptId}
          label="Try again"
        />
      </section>
    );
  }

  return (
    <p
      role="status"
      className="rounded-lg border border-stone-200 p-5 text-sm dark:border-stone-800"
    >
      Writing a lesson on {view.conceptTitle} from your pull request. This usually takes a minute or
      two; the page updates itself.
    </p>
  );
}
