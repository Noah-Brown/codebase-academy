import { schema } from "@academy/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "./auth";
import { getDatabase } from "./db";

/** For pages that need a signed-in user who has chosen a starting level. Redirects otherwise. */
export async function requireOnboardedUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  const db = getDatabase();
  if (!user || !db) redirect("/onboarding");
  const [row] = await db
    .select({ startingLevel: schema.users.startingLevel })
    .from(schema.users)
    .where(eq(schema.users.id, user.id));
  if (!row?.startingLevel) redirect("/onboarding");
  return user;
}
