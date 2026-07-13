import pino from "pino";
import { getRedis } from "@ciintel/queue";
import { createWebhookIngestionWorker } from "./workers/webhook-ingestion.js";
import { createDlqWorker } from "./workers/dlq.js";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

logger.info("Starting CyclOps worker process");

const webhookIngestionWorker = createWebhookIngestionWorker();
const dlqWorker = createDlqWorker();

logger.info(
  {
    workers: ["webhook-ingestion (concurrency=20)", "dlq (concurrency=5)"],
  },
  "Workers started"
);

// WHK-05: Verify Redis server is configured for job workloads.
(async () => {
  try {
    const redis = getRedis();
    const result = await redis.config("GET", "maxmemory-policy");
    const policyValue = Array.isArray(result) ? result[1] : undefined;
    if (policyValue !== "noeviction") {
      logger.warn(
        { currentPolicy: policyValue ?? "unknown" },
        "WARNING: Redis maxmemory-policy is not 'noeviction'. " +
        "BullMQ jobs may be silently evicted under memory pressure. " +
        "Set maxmemory-policy=noeviction in Railway Redis service config."
      );
    } else {
      logger.info({ maxmemoryPolicy: policyValue }, "Redis maxmemory-policy check passed");
    }
  } catch (err) {
    logger.warn({ err }, "Could not verify Redis maxmemory-policy — skipping check");
  }
})();

async function shutdown(): Promise<void> {
  logger.info("Shutting down workers...");
  await Promise.all([
    webhookIngestionWorker.close(),
    dlqWorker.close(),
  ]);
  logger.info("Workers stopped gracefully");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
