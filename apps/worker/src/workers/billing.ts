import { Worker } from "bullmq";
import { getRedis, billingQueue, MarketplacePurchaseJobSchema } from "@cyclops/queue";
import type { MarketplacePurchaseJob } from "@cyclops/queue";
import { getDb } from "@cyclops/db";
import { deriveTransition } from "../lib/billing-state.js";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function createBillingWorker() {
  const worker = new Worker<MarketplacePurchaseJob>(
    "billing",
    async (job) => {
      const parsed = MarketplacePurchaseJobSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error({ errors: parsed.error.errors }, "Invalid billing job — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const event = parsed.data;
      const db = getDb();

      const installation = await db.installation.findUnique({
        where: { targetId: event.accountId },
        select: { id: true, billingStatus: true },
      });

      if (!installation) {
        logger.warn(
          { accountId: event.accountId, eventType: event.eventType },
          "No installation found for marketplace account — skipping"
        );
        return { skipped: true, reason: "installation_not_found" };
      }

      const transition = deriveTransition(event);

      if (event.eventType === "marketplace_purchase_cancelled" && transition.billingCancelAt) {
        const isFuture = transition.billingCancelAt > new Date();
        if (isFuture) {
          // Store billingCancelAt only — do NOT change billingStatus (lazy check will flip it later)
          await db.installation.update({
            where: { id: installation.id },
            data: {
              billingCancelAt: transition.billingCancelAt,
              marketplacePlanId: transition.marketplacePlanId,
              marketplacePlanName: transition.marketplacePlanName,
            },
          });
          logger.info(
            { installationId: installation.id, billingCancelAt: transition.billingCancelAt },
            "Future cancellation stored — billing active until effective date"
          );
          return { ok: true };
        }
      }

      await db.installation.update({
        where: { id: installation.id },
        data: {
          billingStatus: transition.billingStatus,
          trialEndsAt: transition.trialEndsAt,
          billingCancelAt: transition.billingCancelAt,
          marketplacePlanId: transition.marketplacePlanId,
          marketplacePlanName: transition.marketplacePlanName,
        },
      });

      logger.info(
        {
          installationId: installation.id,
          previousStatus: installation.billingStatus,
          newStatus: transition.billingStatus,
          eventType: event.eventType,
        },
        "Billing state transition applied"
      );

      return { ok: true };
    },
    {
      connection: getRedis(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "BillingWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "BillingWorker error");
  });

  return worker;
}
