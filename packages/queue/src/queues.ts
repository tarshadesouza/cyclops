import { Queue } from "bullmq";
import { getRedis } from "./redis.js";
import type {
  WebhookIngestionJob,
  DetectorDispatchJob,
  AiAnalysisJob,
  ActionExecutionJob,
  AgentFixJob,
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

// The agent fix loop is a LONG-RUNNING job (polls CI for many minutes). Never
// auto-retry it — a retry would re-run the whole expensive loop from scratch;
// the FixSession row is the source of truth for what already happened.
export const agentFixQueue = new Queue<AgentFixJob>(
  "agent-fix",
  {
    connection: getRedis(),
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 1,
      backoff: undefined,
    },
  }
);
