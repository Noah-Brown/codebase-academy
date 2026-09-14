"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export function signInWithGitHub(callbackURL = "/onboarding") {
  return authClient.signIn.social({ provider: "github", callbackURL });
}

export function signOut() {
  return authClient.signOut();
}
