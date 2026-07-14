import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { billingQueue, MarketplacePurchaseJobSchema } from "@cyclops/queue";
import type { MarketplacePurchaseJob } from "@cyclops/queue";

function verifyMarketplaceSignature(secret: string, rawBody: string, header: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  const secret = process.env["MARKETPLACE_WEBHOOK_SECRET"];
  if (!secret) {
    throw new Error("MARKETPLACE_WEBHOOK_SECRET environment variable is required");
  }

  app.post("/marketplace/webhooks", { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const event = request.headers["x-github-event"] as string | undefined;

    if (!signature || !event) {
      return reply.status(400).send({ error: "Missing required headers" });
    }
    if (!request.rawBody) {
      return reply.status(400).send({ error: "Raw body not available" });
    }

    if (!verifyMarketplaceSignature(secret, request.rawBody as string, signature)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    // Only handle marketplace_purchase events
    if (!["marketplace_purchase"].includes(event)) {
      return reply.status(200).send({ received: true, ignored: true });
    }

    const body = request.body as Record<string, unknown>;
    const action: string = (body?.["action"] as string) ?? "";

    const eventTypeMap: Record<string, MarketplacePurchaseJob["eventType"]> = {
      purchased: "marketplace_purchase",
      cancelled: "marketplace_purchase_cancelled",
      changed: "marketplace_plan_changed",
      pending_change: "marketplace_plan_changed",
    };
    const eventType = eventTypeMap[action];
    if (!eventType) {
      return reply.status(200).send({ received: true, ignored: true, reason: `unknown_action:${action}` });
    }

    const marketplace = (body["marketplace_purchase"] as Record<string, unknown>) ?? body;
    const account = (marketplace["account"] as Record<string, unknown>) ?? (body["sender"] as Record<string, unknown>) ?? {};
    const plan = (marketplace["plan"] as Record<string, unknown>) ?? {};

    const jobData: MarketplacePurchaseJob = {
      eventType,
      accountId: account["id"] as number,
      accountLogin: account["login"] as string,
      accountType: ((account["type"] as string) ?? "Organization") as "Organization" | "User",
      planId: (plan["id"] as number) ?? 0,
      planName: (plan["name"] as string) ?? "unknown",
      onFreeTrial: (marketplace["on_free_trial"] as boolean) ?? false,
      freeTrialEndsOn: (marketplace["free_trial_ends_on"] as string) ?? null,
      effectiveDate: (marketplace["effective_date"] as string) ?? new Date().toISOString(),
    };

    const parsed = MarketplacePurchaseJobSchema.safeParse(jobData);
    if (!parsed.success) {
      app.log.error({ errors: parsed.error.errors }, "Invalid marketplace job payload — discarding");
      return reply.status(400).send({ error: "Invalid event payload" });
    }

    await billingQueue.add("marketplace-event", parsed.data, {
      jobId: `marketplace-${account["id"] as number}-${Date.now()}`,
    });

    app.log.info({ accountId: account["id"], eventType, action }, "Marketplace event enqueued");
    return reply.status(202).send({ received: true });
  });
}
