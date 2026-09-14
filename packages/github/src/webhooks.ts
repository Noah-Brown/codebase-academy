import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";

const SIGNATURE_HEADER = /^sha256=[0-9a-f]{64}$/;

/**
 * Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time compare).
 * Returns `false` for any malformed input and never throws.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (typeof secret !== "string" || secret === "") return false;
  if (typeof rawBody !== "string" || rawBody === "") return false;
  if (typeof signatureHeader !== "string" || !SIGNATURE_HEADER.test(signatureHeader)) return false;
  try {
    return await verify(secret, rawBody, signatureHeader);
  } catch {
    return false;
  }
}

export const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
] as const;
export const INSTALLATION_REPOSITORIES_ACTIONS = ["added", "removed"] as const;
export const PULL_REQUEST_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "closed",
] as const;

const id = z.number().int().positive();

const installationSchema = z.object({
  id,
  account: z.object({ login: z.string().min(1), type: z.string().min(1) }),
  // Null and missing both become absent, so consumers see `string | undefined`.
  suspended_at: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
});

const repositoryRefSchema = z.object({
  id,
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
});
export type WebhookRepositoryRef = z.infer<typeof repositoryRefSchema>;

const installationEventSchema = z.object({
  action: z.enum(INSTALLATION_ACTIONS),
  installation: installationSchema,
  repositories: z.array(repositoryRefSchema).optional(),
});

const installationRepositoriesEventSchema = z.object({
  action: z.enum(INSTALLATION_REPOSITORIES_ACTIONS),
  installation: installationSchema,
  repositories_added: z.array(repositoryRefSchema),
  repositories_removed: z.array(repositoryRefSchema),
});

const pullRequestEventSchema = z.object({
  action: z.enum(PULL_REQUEST_ACTIONS),
  installation: z.object({ id }),
  repository: z.object({
    id,
    name: z.string().min(1),
    full_name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
    default_branch: z.string().min(1),
    private: z.boolean(),
  }),
  // The body is deliberately not part of the schema, so it is stripped from the parsed event.
  pull_request: z.object({
    number: id,
    title: z.string(),
    state: z.enum(["open", "closed"]),
    user: z.object({ login: z.string().min(1) }),
    base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
    head: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
    html_url: z.string(),
    updated_at: z.string(),
    merged: z.boolean().nullish(),
  }),
});

export type InstallationWebhookEvent = { kind: "installation" } & z.infer<
  typeof installationEventSchema
>;
export type InstallationRepositoriesWebhookEvent = { kind: "installation_repositories" } & z.infer<
  typeof installationRepositoriesEventSchema
>;
export type PullRequestWebhookEvent = { kind: "pull_request" } & z.infer<
  typeof pullRequestEventSchema
>;
export type IgnoredWebhookEvent = { kind: "ignored"; reason: string };

export type WebhookEvent =
  | InstallationWebhookEvent
  | InstallationRepositoriesWebhookEvent
  | PullRequestWebhookEvent
  | IgnoredWebhookEvent;

function actionOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("action" in payload)) return undefined;
  const action = (payload as { action: unknown }).action;
  return typeof action === "string" ? action : undefined;
}

/**
 * Parse a verified webhook delivery (`X-GitHub-Event` name plus JSON payload) into the events
 * this app handles. Everything else, including invalid payloads, becomes `{ kind: "ignored" }`.
 * Reasons never include payload content.
 */
export function parseWebhookEvent(
  eventName: string | null | undefined,
  payload: unknown,
): WebhookEvent {
  const action = actionOf(payload);
  const actionsByEvent: Record<string, readonly string[]> = {
    installation: INSTALLATION_ACTIONS,
    installation_repositories: INSTALLATION_REPOSITORIES_ACTIONS,
    pull_request: PULL_REQUEST_ACTIONS,
  };

  if (
    eventName !== "installation" &&
    eventName !== "installation_repositories" &&
    eventName !== "pull_request"
  ) {
    const safeName = String(eventName ?? "missing")
      .replace(/[^a-z_]/g, "")
      .slice(0, 64);
    return { kind: "ignored", reason: `unsupported_event:${safeName}` };
  }
  if (action === undefined || !actionsByEvent[eventName]?.includes(action)) {
    const safeAction =
      action === undefined ? "missing" : action.replace(/[^a-z_]/g, "").slice(0, 64);
    return { kind: "ignored", reason: `unsupported_action:${eventName}.${safeAction}` };
  }

  switch (eventName) {
    case "installation": {
      const parsed = installationEventSchema.safeParse(payload);
      return parsed.success
        ? { kind: "installation", ...parsed.data }
        : { kind: "ignored", reason: `invalid_payload:${eventName}` };
    }
    case "installation_repositories": {
      const parsed = installationRepositoriesEventSchema.safeParse(payload);
      return parsed.success
        ? { kind: "installation_repositories", ...parsed.data }
        : { kind: "ignored", reason: `invalid_payload:${eventName}` };
    }
    case "pull_request": {
      const parsed = pullRequestEventSchema.safeParse(payload);
      return parsed.success
        ? { kind: "pull_request", ...parsed.data }
        : { kind: "ignored", reason: `invalid_payload:${eventName}` };
    }
  }
}
