"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signInWithGitHub, signOut } from "@/lib/auth-client";

const buttonClass =
  "rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300";

export function SignInButton({ callbackURL }: { callbackURL?: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={buttonClass}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailed(false);
          const result = await signInWithGitHub(callbackURL);
          if (result?.error) {
            setPending(false);
            setFailed(true);
          }
        }}
      >
        {pending ? "Redirecting to GitHub…" : "Sign in with GitHub"}
      </button>
      {failed && (
        <p className="text-sm text-red-700 dark:text-red-400">
          Sign-in could not start. Check the setup page, then try again.
        </p>
      )}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-sm text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      onClick={async () => {
        await signOut();
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
