import { Worker } from "bullmq";
import {
  getRedis,
  webhookIngestionQueue,
  detectorDispatchQueue,
  dlqQueue,
  WebhookIngestionJobSchema,
  type WebhookIngestionJob,
} from "@ciintel/queue";
import { getDb } from "@ciintel/db";
import { checkInstallationActive } from "../lib/installation.js";
import pino from "pino";
import type { Job } from "bullmq";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

async function handleInstallationCreated(installationId: number): Promise<void> {
  const db = getDb();
  await db.installation.upsert({
    where: { id: installationId },
    create: {
      id: installationId,
      accountLogin: "unknown",
      accountType: "Organization",
      appId: parseInt(process.env["GITHUB_APP_ID"] ?? "0", 10),
      targetId: installationId,
      targetType: "Organization",
      suspended: false,
    },
    update: {
      suspended: false,
      deletedAt: null,
    },
  });
  logger.info({ installationId }, "Installation created/upserted");
}

async function handleInstallationDeleted(installationId: number): Promise<void> {
  const db = getDb();

  await db.installation.update({
    where: { id: installationId },
    data: { deletedAt: new Date() },
  });

  // Drain waiting and delayed jobs for this tenant from all queues
  const tenantJobFilter = async (job: Job): Promise<boolean> => {
    const data = job.data as { installationId?: number };
    return data.installationId === installationId;
  };

  const queues = [webhookIngestionQueue, detectorDispatchQueue];
  for (const queue of queues) {
    const waitingJobs = await queue.getWaiting();
    for (const job of waitingJobs) {
      if (await tenantJobFilter(job)) {
        await job.remove();
        logger.info({ jobId: job.id, queueName: queue.name, installationId }, "Drained job for deleted installation");
      }
    }
    const delayedJobs = await queue.getDelayed();
    for (const job of delayedJobs) {
      if (await tenantJobFilter(job)) {
        await job.remove();
      }
    }
  }

  logger.info({ installationId }, "Installation deleted, queued jobs drained");
}

async function handleInstallationSuspended(installationId: number): Promise<void> {
  const db = getDb();
  await db.installation.update({
    where: { id: installationId },
    data: { suspended: true },
  });
  logger.info({ installationId }, "Installation suspended");
}

async function handleInstallationUnsuspended(installationId: number): Promise<void> {
  const db = getDb();
  await db.installation.update({
    where: { id: installationId },
    data: { suspended: false },
  });
  logger.info({ installationId }, "Installation unsuspended");
}

export function createWebhookIngestionWorker(): Worker<WebhookIngestionJob> {
  const worker = new Worker<WebhookIngestionJob>(
    "webhook-ingestion",
    async (job) => {
      const jobLog = logger.child({ jobId: job.id, deliveryId: job.data.deliveryId });

      const parsed = WebhookIngestionJobSchema.safeParse(job.data);
      if (!parsed.success) {
        jobLog.error({ errors: parsed.error.errors }, "Invalid job data — discarding");
        return { skipped: true, reason: "invalid_data" };
      }

      const { installationId, deliveryId, eventName, action } = parsed.data;

      // TEN-04: Check installation is active before any processing
      const check = await checkInstallationActive(installationId, jobLog as pino.Logger);
      if (!check.active) {
        return { skipped: true, reason: check.reason };
      }

      jobLog.info({ installationId, eventName, action }, "Processing webhook delivery");

      if (eventName === "installation") {
        switch (action) {
          case "created":
            await handleInstallationCreated(installationId);
            break;
          case "deleted":
            await handleInstallationDeleted(installationId);
            break;
          case "suspend":
            await handleInstallationSuspended(installationId);
            break;
          case "unsuspend":
            await handleInstallationUnsuspended(installationId);
            break;
          default:
            jobLog.info({ action }, "Unhandled installation action — skipping");
        }
        return { processed: true, eventName, action };
      }

      if (eventName === "installation_repositories") {
        jobLog.info({ action, installationId }, "Repository access changed — tracking in Phase 2");
        return { processed: true, eventName, action };
      }

      // CI events — dispatcher implemented in Phase 2
      jobLog.info({ eventName, action, installationId }, "CI event received — dispatcher implemented in Phase 2");

      return { processed: true, eventName };
    },
    {
      connection: getRedis(),
      concurrency: 20,  // WHK-04: webhook-ingestion concurrency
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "WebhookIngestionWorker job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "WebhookIngestionWorker error");
  });

  // DLQ routing: route exhausted-retry jobs to DLQ for observability
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await dlqQueue.add("exhausted", {
        originalQueue: "webhook-ingestion",
        jobId: job.id,
        jobName: job.name,
        jobData: job.data,
        error: err.message,
        failedAt: new Date().toISOString(),
      }, { removeOnComplete: false });
    }
  });

  return worker;
}
