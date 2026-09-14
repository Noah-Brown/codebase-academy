import { createLogger } from "@academy/shared";
import { getWebEnv } from "@/lib/config";
import { getDatabase } from "@/lib/db";
import { handleWebhookDelivery } from "@/lib/webhook-handler";

export const dynamic = "force-dynamic";

const log = createLogger({ bindings: { route: "github-webhook" } });

export async function POST(request: Request) {
  const env = getWebEnv();
  const db = getDatabase();
  if (!env || !db) return Response.json({ error: "not_configured" }, { status: 503 });

  const result = await handleWebhookDelivery(
    db,
    env.GITHUB_APP_WEBHOOK_SECRET,
    {
      eventName: request.headers.get("x-github-event"),
      signature: request.headers.get("x-hub-signature-256"),
      deliveryId: request.headers.get("x-github-delivery"),
      rawBody: await request.text(),
    },
    log,
  );
  return Response.json(result.body, { status: result.status });
}
