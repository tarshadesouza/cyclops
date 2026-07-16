import { z } from "zod";

export const WebhookIngestionJobSchema = z.object({
  installationId: z.number().int().positive(),
  deliveryId: z.string().uuid(),
  eventName: z.string(),
  action: z.string().optional(),
  // Account details from the installation payload — used to create the tenant row
  // with real values (targetId must equal the marketplace account id for billing).
  account: z
    .object({
      id: z.number().int().positive(),
      login: z.string(),
      type: z.string(),
      appId: z.number().int(),
      targetType: z.string(),
    })
    .optional(),
});
export type WebhookIngestionJob = z.infer<typeof WebhookIngestionJobSchema>;

export const DetectorDispatchJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  workflowRunId: z.number().int().positive().optional(),
  ref: z.string(),
  sha: z.string().length(40),
});
export type DetectorDispatchJob = z.infer<typeof DetectorDispatchJobSchema>;

export const AiAnalysisJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId:   z.number().int().positive(),
  checkRunId:     z.number().int().positive(),
  findingId:      z.string().uuid(),
  detectorType:   z.string(),
  sha:            z.string().length(40),
});
export type AiAnalysisJob = z.infer<typeof AiAnalysisJobSchema>;

export const ACTION_TYPES = [
  'upsert-pr-comment',
  'update-check-run',
  'create-autofix-pr-lint',
  'create-autofix-pr-snapshot',
  'rerun-workflow',
  'cancel-workflow',
  'send-slack-alert',
  'create-github-issue',
] as const;

export type ActionType = typeof ACTION_TYPES[number];

export const ActionExecutionJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId:   z.number().int().positive(),
  checkRunId:     z.number().int().positive(),
  findingId:      z.string().uuid(),
  actionType:     z.enum(ACTION_TYPES),
  sha:            z.string().length(40),
  ref:            z.string().optional(),
});
export type ActionExecutionJob = z.infer<typeof ActionExecutionJobSchema>;

export const MarketplacePurchaseJobSchema = z.object({
  eventType: z.enum([
    "marketplace_purchase",
    "marketplace_purchase_cancelled",
    "marketplace_plan_changed",
  ]),
  accountId: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
  planId: z.number().int(),
  planName: z.string(),
  onFreeTrial: z.boolean(),
  freeTrialEndsOn: z.string().nullable(), // ISO date string or null
  effectiveDate: z.string(), // ISO date string
});
export type MarketplacePurchaseJob = z.infer<typeof MarketplacePurchaseJobSchema>;
