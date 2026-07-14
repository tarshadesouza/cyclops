import { Queue } from "bullmq";
import { getRedis } from "./redis.js";
import type {
  WebhookIngestionJob,
  DetectorDispatchJob,
  AiAnalysisJob,
  ActionExecutionJob,
  MarketplacePurchaseJob,
} from "./jobs.js";

const defaultJobOptions = {
  removeOnComplete: { count: 1000, age: 86400 },
  removeOnFail: { count: 5000, age: 604800 },
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

export const webhookIngestionQueue = new Queue<WebhookIngestionJob>(
  "webhook-ingestion",
  { connection: getRedis(), defaultJobOptions }
);

export const detectorDispatchQueue = new Queue<DetectorDispatchJob>(
  "detector-dispatch",
  { connection: getRedis(), defaultJobOptions }
);

export const aiAnalysisQueue = new Queue<AiAnalysisJob>(
  "ai-analysis",
  { connection: getRedis(), defaultJobOptions }
);

export const actionExecutionQueue = new Queue<ActionExecutionJob>(
  "action-execution",
  { connection: getRedis(), defaultJobOptions }
);

export const dlqQueue = new Queue(
  "dlq",
  { connection: getRedis(), defaultJobOptions: { removeOnFail: false } }
);

export const billingQueue = new Queue<MarketplacePurchaseJob>(
  "billing",
  { connection: getRedis(), defaultJobOptions }
);
