import { z } from "zod";
import { GitHubApiError } from "./errors";

export const GITHUB_API_URL = "https://api.github.com";
const MAX_PAGES = 50;

export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
}

export interface ListUserInstallationsOptions {
  fetch?: typeof globalThis.fetch;
}

const pageSchema = z.object({
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      // Enterprise installations have no login and cannot own repositories; they are skipped.
      account: z.object({ login: z.string().optional(), type: z.string().optional() }).nullable(),
    }),
  ),
});

/** The `rel="next"` URL from a GitHub `Link` header, if any. */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

/**
 * Installations the user can access, per `GET /user/installations` called with the user's own
 * GitHub token. This is the only source of truth for linking a user to an installation.
 */
export async function listUserInstallations(
  userAccessToken: string,
  options: ListUserInstallationsOptions = {},
): Promise<UserInstallation[]> {
  if (!userAccessToken) throw new GitHubApiError("missing_user_access_token");
  const doFetch = options.fetch ?? globalThis.fetch;
  const installations: UserInstallation[] = [];
  let url: string | null = `${GITHUB_API_URL}/user/installations?per_page=100`;

  for (let page = 0; url !== null; page += 1) {
    if (page >= MAX_PAGES) throw new GitHubApiError("user_installations_page_limit");
    const response: Response = await doFetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
        "user-agent": "codebase-academy",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new GitHubApiError("user_installations_failed", response.status);
    const parsed = pageSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new GitHubApiError("unexpected_response", response.status);

    for (const installation of parsed.data.installations) {
      const login = installation.account?.login;
      if (!login) continue;
      installations.push({
        id: installation.id,
        accountLogin: login,
        accountType: installation.account?.type ?? "User",
      });
    }

    url = nextPageUrl(response.headers.get("link"));
    // Never send the user's token anywhere but the GitHub API.
    if (url !== null && !url.startsWith(`${GITHUB_API_URL}/`)) {
      throw new GitHubApiError("unexpected_pagination_url");
    }
  }
  return installations;
}
