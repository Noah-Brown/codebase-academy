import { z } from "zod";

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/** Variables every server-side process understands. Milestone-specific ones are added later. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: logLevelSchema.default("info"),
});

export const databaseEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "must be a postgres:// URL"),
});

/** Sign-in (Better Auth with the GitHub App's OAuth client). */
export const authEnvSchema = z.object({
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -base64 33)"),
  AUTH_GITHUB_ID: z.string().min(1),
  AUTH_GITHUB_SECRET: z.string().min(1),
  APP_BASE_URL: z.string().url(),
});

/** GitHub App credentials used to mint short-lived installation tokens and verify webhooks. */
export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/, "must be the app's URL slug"),
  // .env files usually store the PEM on one line with literal \n sequences.
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .transform((key) => key.replace(/\\n/g, "\n"))
    .refine((key) => /-----BEGIN (RSA )?PRIVATE KEY-----/.test(key), "must be a PEM private key"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters"),
});

export const webEnvSchema = databaseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(githubAppEnvSchema.shape);

export const workerEnvSchema = databaseEnvSchema.extend(githubAppEnvSchema.shape);

/** Names of variables that are missing or invalid — for "not configured yet" screens. Never includes values. */
export function invalidEnvKeys(
  schema: z.ZodObject,
  source: Record<string, string | undefined> = process.env,
): string[] {
  const result = schema.safeParse(source);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(root)")))].sort();
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/** Parse environment variables, reporting every problem at once (never echoing values). */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}
