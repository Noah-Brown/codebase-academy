import {
  addInstallationRepositories,
  markInstallationDeleted,
  removeInstallationRepositories,
  setInstallationSuspended,
  upsertInstallation,
  upsertPullRequest,
  type Database,
} from "@academy/db";
import {
  parseWebhookEvent,
  toInstallationRecord,
  toPullRequestRecord,
  toRepositoryRecord,
  verifyWebhookSignature,
} from "@academy/github";
import type { Logger } from "@academy/shared";

export interface WebhookDelivery {
  eventName: string | null;
  signature: string | null;
  deliveryId: string | null;
  rawBody: string;
}

export interface WebhookResult {
  status: number;
  body: { ok: true; kind: string } | { error: string };
}

/**
 * Verify and apply one GitHub webhook delivery. Nothing is parsed or stored before the
 * signature checks out. Pull request events update metadata only; analysis is user-initiated.
 */
export async function handleWebhookDelivery(
  db: Database,
  secret: string,
  delivery: WebhookDelivery,
  log: Logger,
): Promise<WebhookResult> {
  if (!(await verifyWebhookSignature(secret, delivery.rawBody, delivery.signature))) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  const event = parseWebhookEvent(delivery.eventName ?? "", payload);
  log.info("webhook received", {
    eventName: delivery.eventName,
    kind: event.kind,
    deliveryId: delivery.deliveryId,
  });

  switch (event.kind) {
    case "installation": {
      const installation = toInstallationRecord(event.installation);
      if (event.action === "deleted") {
        await markInstallationDeleted(db, installation.id);
      } else if (event.action === "suspend" || event.action === "unsuspend") {
        await setInstallationSuspended(db, installation.id, event.action === "suspend");
      } else {
        await upsertInstallation(db, withoutSuspension(installation));
        if (event.repositories?.length) {
          await addInstallationRepositories(
            db,
            installation.id,
            event.repositories.map(toRepositoryRecord),
          );
        }
      }
      break;
    }
    case "installation_repositories": {
      const installation = toInstallationRecord(event.installation);
      await upsertInstallation(db, withoutSuspension(installation));
      if (event.repositories_added.length) {
        await addInstallationRepositories(
          db,
          installation.id,
          event.repositories_added.map(toRepositoryRecord),
        );
      }
      if (event.repositories_removed.length) {
        await removeInstallationRepositories(
          db,
          installation.id,
          event.repositories_removed.map((repository) => repository.id),
        );
      }
      break;
    }
    case "pull_request": {
      // The repository row may not exist yet if this delivery beats the installation sync.
      await addInstallationRepositories(db, event.installation.id, [
        toRepositoryRecord(event.repository),
      ]);
      await upsertPullRequest(db, event.repository.id, toPullRequestRecord(event.pull_request));
      break;
    }
    case "ignored":
      break;
  }
  return { status: 202, body: { ok: true, kind: event.kind } };
}

/** Webhook payloads don't carry suspension state, so upserting from them must not clear it. */
function withoutSuspension<T extends { suspendedAt?: Date | null }>(
  record: T,
): Omit<T, "suspendedAt"> {
  const { suspendedAt: _suspendedAt, ...rest } = record;
  return rest;
}
