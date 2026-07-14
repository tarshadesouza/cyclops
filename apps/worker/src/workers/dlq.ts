import { Worker } from "bullmq";
import { getRedis } from "@cyclops/queue";
import pino from "pino";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

export function createDlqWorker(): Worker {
  const worker = new Worker(
    "dlq",
    async (job) => {
      logger.error(
        {
          jobId: job.id,
          jobName: job.name,
          data: job.data,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
        },
        "Job moved to DLQ after exhausting retries"
      );
    },
    {
      connection: getRedis(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "DLQ worker job failed unexpectedly");
  });

  return worker;
}
