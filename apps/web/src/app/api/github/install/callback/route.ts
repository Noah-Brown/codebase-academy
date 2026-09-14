import {
  linkVerifiedUserInstallation,
  syncInstallationRepositories,
  upsertInstallation,
} from "@academy/db";
import { listUserInstallations } from "@academy/github";
import { createLogger } from "@academy/shared";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { getCurrentUser, getGitHubUserToken } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { getGitHubApp } from "@/lib/github";

export const dynamic = "force-dynamic";

const log = createLogger({ bindings: { route: "github-install-callback" } });

/**
 * GitHub redirects here after the app is installed or its repository access changes.
 * The `installation_id` query parameter is untrusted: installations are linked only if
 * GitHub lists them for this user's own token.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) redirect("/onboarding");
  const db = getDatabase();
  const app = getGitHubApp();
  if (!db || !app) redirect("/setup");

  const token = await getGitHubUserToken(user.id);
  if (!token) redirect("/repositories?status=sign_in_again");

  const requested = Number(request.nextUrl.searchParams.get("installation_id"));
  let status = "installed";
  try {
    const installations = await listUserInstallations(token);
    if (
      Number.isSafeInteger(requested) &&
      requested > 0 &&
      !installations.some((i) => i.id === requested)
    ) {
      status = "not_authorized";
    }
    for (const installation of installations) {
      await upsertInstallation(db, installation);
      await linkVerifiedUserInstallation(db, { userId: user.id, installationId: installation.id });
      const repositories = await app.listInstallationRepositories(installation.id);
      await syncInstallationRepositories(db, installation.id, repositories);
    }
    log.info("installations synced", { userId: user.id, installations: installations.length });
  } catch (error) {
    log.error("installation sync failed", { userId: user.id, error });
    status = "github_unavailable";
  }
  redirect(`/repositories?status=${status}`);
}
