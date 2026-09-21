"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { AttemptView, ReadyLessonView } from "@/lib/lesson-view";
import { CodeEvidence, Prose } from "./code-evidence";

const ERROR_TEXT: Record<string, string> = {
  not_current_step: "This lesson moved on in another tab. Refreshing.",
  answer_first: "Answer this check before moving on.",
  not_ready: "The lesson isn't ready yet.",
  invalid_request: "That answer couldn't be sent. Check it and try again.",
  not_found: "This lesson is no longer available to you.",
};

const DEPTH_TEXT: Record<string, string> = {
  intro: "Introduction",
  applied: "Applied",
  advanced: "Advanced",
  defense: "Engineering defense",
};

const MET_TEXT: Record<string, string> = {
  yes: "Covered",
  partial: "Partly covered",
  no: "Missing",
};

const button =
  "rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60 dark:border-stone-700 dark:hover:bg-stone-900";
const primaryButton =
  "rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300";

type Post = (url: string, body?: unknown) => Promise<boolean>;

function usePost(): { post: Post; pending: boolean; error: string | null } {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post: Post = async (url, body) => {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    const json = response ? await response.json().catch(() => ({})) : {};
    setPending(false);
    if (!response?.ok) {
      setError(ERROR_TEXT[json.error] ?? "Something went wrong. Try again.");
      if (json.error === "not_current_step") router.refresh();
      return false;
    }
    router.refresh();
    return true;
  };
  return { post, pending, error };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
      {error}
    </p>
  ) : null;
}

function MasteryNote({ attempt }: { attempt: AttemptView }) {
  if (!attempt.mastery) return null;
  if (!attempt.mastery.applied) {
    return (
      <p className="text-xs text-stone-500">
        This answer was hard to grade confidently, so it didn&apos;t change your mastery.
      </p>
    );
  }
  return (
    <p className="text-xs text-stone-500">
      Counted as evidence (weight {attempt.mastery.appliedWeight.toFixed(1)}).
    </p>
  );
}

function FlagGrade({ attempt, post }: { attempt: AttemptView; post: Post }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  if (attempt.flagged) {
    return <p className="text-xs text-stone-500">Thanks, this grade is marked for review.</p>;
  }
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-stone-500 underline"
        onClick={() => setOpen(true)}
      >
        This grade seems wrong
      </button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        await post(`/api/assessment-attempts/${attempt.id}/flag`, { note: note || undefined });
      }}
    >
      <label htmlFor={noteId} className="block text-xs text-stone-600 dark:text-stone-400">
        What seems wrong? (optional)
      </label>
      <textarea
        id={noteId}
        value={note}
        maxLength={1_000}
        rows={2}
        onChange={(event) => setNote(event.target.value)}
        className="w-full rounded-md border border-stone-300 bg-transparent p-2 text-sm dark:border-stone-700"
      />
      <button type="submit" className={button}>
        Send
      </button>
    </form>
  );
}

function MultipleChoice({
  view,
  index,
  attempt,
  post,
  pending,
}: {
  view: ReadyLessonView;
  index: number;
  attempt: AttemptView | null;
  post: Post;
  pending: boolean;
}) {
  const step = view.steps[index];
  const [choice, setChoice] = useState<string | null>(null);
  const legendId = useId();
  if (step?.type !== "multiple_choice") return null;
  const reveal = attempt?.reveal?.type === "multiple_choice" ? attempt.reveal : null;
  const submitUrl = `/api/lesson-sessions/${view.session!.id}/steps/${index}/submit`;

  return (
    <div className="space-y-4">
      <fieldset
        className="space-y-2"
        disabled={Boolean(attempt) || pending}
        aria-describedby={legendId}
      >
        <legend id={legendId} className="pb-2 font-medium">
          {step.prompt}
        </legend>
        {step.choices.map((option) => {
          const chosen = (attempt?.choiceId ?? choice) === option.id;
          const isCorrect = reveal?.correctChoiceId === option.id;
          return (
            <label
              key={option.id}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                reveal && isCorrect
                  ? "border-emerald-600 dark:border-emerald-500"
                  : reveal && chosen
                    ? "border-red-600 dark:border-red-500"
                    : "border-stone-200 dark:border-stone-800"
              }`}
            >
              <input
                type="radio"
                name={`step-${index}`}
                value={option.id}
                checked={chosen}
                onChange={() => setChoice(option.id)}
                className="mt-0.5"
              />
              <span>
                {option.text}
                {reveal && isCorrect && <span className="sr-only"> (correct answer)</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      {!attempt && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={primaryButton}
            disabled={!choice || pending}
            onClick={() => post(submitUrl, { choiceId: choice })}
          >
            Check answer
          </button>
          <button
            type="button"
            className={button}
            disabled={pending}
            onClick={() => post(submitUrl, { dontKnow: true })}
          >
            I don&apos;t know—teach me
          </button>
        </div>
      )}

      <div aria-live="polite">
        {attempt && reveal && (
          <div className="space-y-2 rounded-lg bg-stone-50 p-4 text-sm dark:bg-stone-900">
            <p className="font-medium">
              {attempt.responseKind === "dont_know"
                ? "Here's how to think about it."
                : attempt.correct
                  ? "That's right."
                  : "Not quite."}
            </p>
            <Prose text={reveal.explanation} />
            <MasteryNote attempt={attempt} />
          </div>
        )}
      </div>
    </div>
  );
}

function OpenResponse({
  view,
  index,
  attempt,
  post,
  pending,
}: {
  view: ReadyLessonView;
  index: number;
  attempt: AttemptView | null;
  post: Post;
  pending: boolean;
}) {
  const step = view.steps[index];
  const router = useRouter();
  const [text, setText] = useState("");
  const answerId = useId();

  useEffect(() => {
    if (attempt?.status !== "grading") return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/assessment-attempts/${attempt.id}`).catch(() => null);
      const body = response?.ok ? await response.json().catch(() => null) : null;
      if (body?.attempt && body.attempt.status !== "grading") router.refresh();
    }, 2_500);
    return () => clearInterval(timer);
  }, [attempt?.id, attempt?.status, router]);

  if (step?.type !== "open_response") return null;
  const reveal = attempt?.reveal?.type === "open_response" ? attempt.reveal : null;
  const submitUrl = `/api/lesson-sessions/${view.session!.id}/steps/${index}/submit`;

  return (
    <div className="space-y-4">
      <label htmlFor={answerId} className="block font-medium">
        {step.prompt}
      </label>
      {attempt?.responseKind === "text" ? (
        <blockquote className="whitespace-pre-wrap rounded-md border border-stone-200 p-3 text-sm dark:border-stone-800">
          {attempt.text}
        </blockquote>
      ) : (
        !attempt && (
          <>
            <textarea
              id={answerId}
              value={text}
              rows={6}
              maxLength={4_000}
              onChange={(event) => setText(event.target.value)}
              className="w-full rounded-md border border-stone-300 bg-transparent p-3 text-sm dark:border-stone-700"
            />
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={primaryButton}
                disabled={text.trim() === "" || pending}
                onClick={() => post(submitUrl, { text })}
              >
                Submit answer
              </button>
              <button
                type="button"
                className={button}
                disabled={pending}
                onClick={() => post(submitUrl, { dontKnow: true })}
              >
                I don&apos;t know—teach me
              </button>
            </div>
          </>
        )
      )}

      <div aria-live="polite" className="space-y-3">
        {attempt?.status === "grading" && (
          <p role="status" className="text-sm text-stone-600 dark:text-stone-400">
            Reading your answer…
          </p>
        )}
        {attempt?.status === "failed" && (
          <div className="space-y-2 text-sm">
            <p>Your answer couldn&apos;t be graded this time.</p>
            <button
              type="button"
              className={button}
              disabled={pending}
              onClick={() => post(submitUrl, { text: attempt.text ?? "" })}
            >
              Try grading again
            </button>
          </div>
        )}
        {attempt?.status === "graded" && reveal && (
          <div className="space-y-3 rounded-lg bg-stone-50 p-4 text-sm dark:bg-stone-900">
            {attempt.feedback && <Prose text={attempt.feedback} />}
            {attempt.criterionResults.length > 0 && (
              <ul className="space-y-1">
                {attempt.criterionResults.map((result) => (
                  <li key={result.criterion} className="flex gap-2">
                    <span className="w-28 shrink-0 text-xs font-medium text-stone-500">
                      {MET_TEXT[result.met]}
                    </span>
                    <span>{result.criterion}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                A strong answer
              </p>
              <Prose text={reveal.exemplarSummary} />
            </div>
            <MasteryNote attempt={attempt} />
            {attempt.responseKind === "text" && <FlagGrade attempt={attempt} post={post} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** One compact step at a time, answer-first, with code evidence above the instruction (brief §16.4). */
export function LessonPlayer({ view }: { view: ReadyLessonView }) {
  const { post, pending, error } = usePost();
  const session = view.session;

  if (!session) {
    return (
      <section className="space-y-4 rounded-lg border-2 border-stone-900 p-5 dark:border-stone-100">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          {DEPTH_TEXT[view.depth]} · about {view.estimatedMinutes} min · {view.steps.length} steps
        </div>
        <h2 className="text-xl font-semibold">{view.title}</h2>
        <Prose text={view.rationale} className="text-sm text-stone-600 dark:text-stone-400" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">You&apos;ll practice</p>
          <ul className="list-disc space-y-0.5 pl-5 text-stone-600 dark:text-stone-400">
            {view.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={primaryButton}
            disabled={pending}
            onClick={() => post(`/api/lessons/${view.lessonId}/sessions`)}
          >
            {pending ? "Starting…" : "Begin lesson"}
          </button>
          <Link
            href={`/analyses/${view.analysisId}`}
            className="text-sm text-stone-500 hover:underline"
          >
            Not now, keep shipping
          </Link>
        </div>
        <ErrorLine error={error} />
      </section>
    );
  }

  const total = view.steps.length;
  const index = Math.min(session.currentStep, total - 1);
  const step = view.steps[index]!;
  const attempt = view.attempts.find((a) => a.stepIndex === index) ?? null;
  const evidence =
    step.type === "takeaway"
      ? []
      : view.evidence.filter((item) => step.evidenceIds.includes(item.id));
  const assessed = step.type === "multiple_choice" || step.type === "open_response";
  const canContinue = step.type !== "takeaway" && (!assessed || attempt?.status === "graded");
  const advance = () => post(`/api/lesson-sessions/${session.id}/advance`, { fromStep: index });

  return (
    <section className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>{view.title}</span>
          <span>
            {index + 1} of {total}
          </span>
        </div>
        <div className="h-1 rounded bg-stone-200 dark:bg-stone-800" aria-hidden="true">
          <div
            className="h-1 rounded bg-stone-900 dark:bg-stone-100"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-stone-200 p-5 dark:border-stone-800">
        <CodeEvidence items={evidence} showRationale={false} />

        {step.type === "explanation" && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">{step.title}</h2>
            <Prose text={step.body} />
          </div>
        )}
        {step.type === "multiple_choice" && (
          <MultipleChoice
            key={index}
            view={view}
            index={index}
            attempt={attempt}
            post={post}
            pending={pending}
          />
        )}
        {step.type === "open_response" && (
          <OpenResponse
            key={index}
            view={view}
            index={index}
            attempt={attempt}
            post={post}
            pending={pending}
          />
        )}
        {step.type === "takeaway" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Takeaway</h2>
            <ul className="list-disc space-y-1 pl-5">
              {step.points.map((point) => (
                <li key={point}>
                  <Prose text={point} />
                </li>
              ))}
            </ul>
            <div className="space-y-1 rounded-lg bg-stone-50 p-4 text-sm dark:bg-stone-900">
              <p className="font-medium">{view.conceptTitle}</p>
              <p>
                {view.statusBefore.label} → <strong>{view.statusNow.label}</strong>
                {view.statusNow.insufficientEvidence && (
                  <span className="text-stone-500"> (still gathering evidence)</span>
                )}
              </p>
              <p className="text-xs text-stone-500">
                {view.attempts.filter((a) => a.mastery?.applied).length} of {view.attempts.length}{" "}
                answers counted toward your mastery.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={`/analyses/${view.analysisId}`} className={primaryButton}>
                Back to the pull request
              </Link>
              <span className="text-sm text-stone-500">Nothing here blocks shipping.</span>
            </div>
          </div>
        )}
      </div>

      {step.type !== "takeaway" && (
        <div className="flex items-center justify-between gap-3">
          <Link
            href={`/analyses/${view.analysisId}`}
            className="text-sm text-stone-500 hover:underline"
          >
            Leave lesson
          </Link>
          <button
            type="button"
            className={primaryButton}
            disabled={!canContinue || pending}
            onClick={advance}
          >
            Continue
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </section>
  );
}
