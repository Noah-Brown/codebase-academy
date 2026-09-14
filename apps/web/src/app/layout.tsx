import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";
import { getCurrentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Codebase Academy",
  description: "Learn software engineering through the code you are shipping.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5">
          <header className="flex flex-wrap items-center justify-between gap-3 py-6">
            <Link href="/" className="font-semibold tracking-tight">
              Codebase Academy
            </Link>
            <nav className="flex flex-wrap items-center gap-5 text-sm text-stone-600 dark:text-stone-400">
              {user && (
                <Link
                  href="/repositories"
                  className="hover:text-stone-900 dark:hover:text-stone-100"
                >
                  Repositories
                </Link>
              )}
              <Link href="/curriculum" className="hover:text-stone-900 dark:hover:text-stone-100">
                Skill map
              </Link>
              <Link
                href="/dev/selection"
                className="hover:text-stone-900 dark:hover:text-stone-100"
              >
                Selection demo
              </Link>
              {user ? (
                <SignOutButton />
              ) : (
                <Link href="/onboarding" className="hover:text-stone-900 dark:hover:text-stone-100">
                  Sign in
                </Link>
              )}
            </nav>
          </header>
          <main className="flex-1 pb-16">{children}</main>
          <footer className="border-t border-stone-200 py-6 text-xs text-stone-500 dark:border-stone-800">
            Learning is always optional. Nothing here blocks you from shipping.
          </footer>
        </div>
      </body>
    </html>
  );
}
