import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookIngestionQueue } from "@cyclops/queue";
import type { WebhookIngestionJob } from "@cyclops/queue";
import { getDb } from "@cyclops/db";

function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string
): boolean {
  const expectedSig = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  try {
    return timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSig)
    );
  } catch {
    return false;
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!webhookSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET environment variable is required");
  }

  // Registered at both /webhooks and /webhooks/github so the GitHub App webhook
  // URL works with or without the /github suffix.
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const deliveryId = request.headers["x-github-delivery"] as string | undefined;
      const eventName = request.headers["x-github-event"] as string | undefined;

      if (!signature || !deliveryId || !eventName) {
        return reply.status(400).send({ error: "Missing required GitHub webhook headers" });
      }

      if (!request.rawBody) {
        return reply.status(400).send({ error: "Raw body not available" });
      }

      const isValid = verifyWebhookSignature(webhookSecret, request.rawBody as string, signature);
      if (!isValid) {
        app.log.warn({ deliveryId }, "Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const installation = (request.body as any).installation as { id?: number } | undefined;
      const installationId = installation?.id;

      if (!installationId || typeof installationId !== "number") {
        app.log.warn({ deliveryId, eventName }, "Webhook delivery has no installation — skipping");
        return reply.status(202).send({ status: "no_installation" });
      }

      const dedupKey = `installation:${installationId}:delivery:${deliveryId}`;
      const isNew = await app.redis.set(dedupKey, "1", "EX", 259200, "NX");
      if (!isNew) {
        app.log.info({ deliveryId }, "Duplicate webhook delivery — skipping");
        return reply.status(202).send({ status: "duplicate" });
      }

      const body = request.body as Record<string, unknown>;
      const action = typeof body["action"] === "string" ? body["action"] : undefined;

      // For CI events, persist the full payload so the ingestion worker can load it
      // (it enqueues identifier-only jobs). The WebhookDelivery FK requires the
      // Installation row to exist, which it does for CI events (installed earlier).
      if (
        eventName === "workflow_run" ||
        eventName === "check_run" ||
        eventName === "issue_comment"
      ) {
        try {
          await getDb().webhookDelivery.create({
            data: { deliveryId, installationId, eventName, action: action ?? null, payload: body },
          });
        } catch (err) {
          app.log.warn(
            { deliveryId, err: (err as Error).message },
            "Could not persist webhook delivery payload"
          );
        }
      }

      // For installation events, forward account details so the worker can create
      // the tenant row with real values (targetId = account id, for billing lookup).
      let account: WebhookIngestionJob["account"];
      if (eventName === "installation") {
        const inst = (request.body as any).installation ?? {};
        const acct = inst.account ?? {};
        if (typeof acct.id === "number" && typeof acct.login === "string") {
          account = {
            id: acct.id,
            login: acct.login,
            type: typeof acct.type === "string" ? acct.type : "Organization",
            appId: typeof inst.app_id === "number" ? inst.app_id : installationId,
            targetType: typeof inst.target_type === "string" ? inst.target_type : "Organization",
          };
        }
      }

      const jobData: WebhookIngestionJob = {
        installationId,
        deliveryId,
        eventName,
        action,
        ...(account ? { account } : {}),
      };

      await webhookIngestionQueue.add("webhook", jobData, {
        jobId: deliveryId,
      });

      app.log.info({ deliveryId, installationId, eventName }, "Webhook enqueued");

      return reply.status(202).send({ status: "accepted" });
  };

  const opts = { config: { rawBody: true } };
  app.post("/webhooks", opts, handler);
  app.post("/webhooks/github", opts, handler);
}
