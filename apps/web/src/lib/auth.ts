import { schema } from "@academy/db";
import { betterAuth } from "better-auth";
import { and, eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { getWebEnv } from "./config";
import { getDatabase } from "./db";

function createAuth() {
  const env = getWebEnv();
  const db = getDatabase();
  if (!env || !db) return null;

  return betterAuth({
    baseURL: env.APP_BASE_URL,
    secret: env.AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    socialProviders: {
      // The GitHub App's own OAuth client: user-to-server tokens carry only the app's permissions.
      github: { clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET },
    },
    account: {
      // Stored GitHub tokens are encrypted at rest; they are only used to list the user's installations.
      encryptOAuthTokens: true,
    },
    plugins: [nextCookies()],
  });
}

type Auth = NonNullable<ReturnType<typeof createAuth>>;
const globalForAuth = globalThis as unknown as { academyAuth?: Auth | null };

/** The Better Auth instance, or null until the database and auth settings are configured. */
export function getAuth(): Auth | null {
  if (globalForAuth.academyAuth === undefined) globalForAuth.academyAuth = createAuth();
  return globalForAuth.academyAuth;
}

export type CurrentUser = { id: string; name: string; email: string; image?: string | null };

/** The signed-in user for this request, or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const auth = getAuth();
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image };
}

/** A fresh GitHub user access token for the signed-in user (refreshed by Better Auth when expired). */
export async function getGitHubUserToken(userId: string): Promise<string | null> {
  const auth = getAuth();
  const db = getDatabase();
  if (!auth || !db) return null;
  const [account] = await db
    .select({ accountId: schema.accounts.accountId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, "github")))
    .limit(1);
  if (!account) return null;
  try {
    const result = await auth.api.getAccessToken({
      body: { accountId: account.accountId, userId },
      headers: await headers(),
    });
    return result?.accessToken ?? null;
  } catch {
    return null;
  }
}
