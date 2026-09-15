import {
  authEnvSchema,
  conceptMapperEnvSchema,
  githubAppEnvSchema,
  invalidEnvKeys,
  parseEnv,
  webEnvSchema,
} from "@academy/shared";

export type WebEnv = ReturnType<typeof parseWebEnv>;

function parseWebEnv() {
  return parseEnv(webEnvSchema);
}

/** Names of settings that still need to be provided. Never includes values. */
export function missingConfiguration(): {
  auth: string[];
  githubApp: string[];
  conceptMapper: string[];
  database: boolean;
} {
  return {
    auth: invalidEnvKeys(authEnvSchema),
    githubApp: invalidEnvKeys(githubAppEnvSchema),
    // Read by the worker; checked here too so this page can say whether mapping will run.
    conceptMapper: invalidEnvKeys(conceptMapperEnvSchema),
    database: !process.env.DATABASE_URL,
  };
}

let cached: WebEnv | null | undefined;

/** The full web configuration, or null when anything required is missing. */
export function getWebEnv(): WebEnv | null {
  if (cached !== undefined) return cached;
  try {
    cached = parseWebEnv();
  } catch {
    cached = null;
  }
  return cached;
}
