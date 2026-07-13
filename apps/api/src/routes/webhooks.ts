import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookIngestionQueue } from "@ciintel/queue";
import type { WebhookIngestionJob } from "@ciintel/queue";

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

  app.post(
    "/webhooks",
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
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

      const jobData: WebhookIngestionJob = {
        installationId,
        deliveryId,
        eventName,
        action,
      };

      await webhookIngestionQueue.add("webhook", jobData, {
        jobId: deliveryId,
      });

      app.log.info({ deliveryId, installationId, eventName }, "Webhook enqueued");

      return reply.status(202).send({ status: "accepted" });
    }
  );
}
