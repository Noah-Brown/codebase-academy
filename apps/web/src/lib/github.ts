import { createGitHubApp, type GitHubAppClient } from "@academy/github";
import { getWebEnv } from "./config";

const globalForGitHub = globalThis as unknown as { academyGitHubApp?: GitHubAppClient | null };

/** The GitHub App client (installation tokens are minted on demand, never stored), or null if unconfigured. */
export function getGitHubApp(): GitHubAppClient | null {
  if (globalForGitHub.academyGitHubApp === undefined) {
    const env = getWebEnv();
    globalForGitHub.academyGitHubApp = env
      ? createGitHubApp({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY })
      : null;
  }
  return globalForGitHub.academyGitHubApp;
}
