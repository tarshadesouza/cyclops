import { z } from "zod";

export const WebhookIngestionJobSchema = z.object({
  installationId: z.number().int().positive(),
  deliveryId: z.string().uuid(),
  eventName: z.string(),
  action: z.string().optional(),
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
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  failureType: z.string(),
  sha: z.string().length(40),
});
export type AiAnalysisJob = z.infer<typeof AiAnalysisJobSchema>;

export const ActionExecutionJobSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  checkRunId: z.number().int().positive(),
  actionType: z.string(),
  actionParams: z.record(z.unknown()),
  sha: z.string().length(40),
});
export type ActionExecutionJob = z.infer<typeof ActionExecutionJobSchema>;
