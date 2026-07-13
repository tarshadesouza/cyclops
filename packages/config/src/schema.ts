import { z } from "zod";

export const CyclopsConfigSchema = z.object({
  detectors: z.object({
    lint:          z.boolean().default(true),
    flakyTest:     z.boolean().default(true),
    build:         z.boolean().default(true),
    testFailure:   z.boolean().default(true),
    missingEnv:    z.boolean().default(true),
    expiredSecret: z.boolean().default(true),
  }).default({}),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
  autofix:             z.boolean().default(true),
  autofixRateLimit:    z.number().int().min(1).max(20).default(3),
  notifications: z.object({
    slack: z.object({
      enabled:    z.boolean().default(true),
      channel:    z.string().optional(),
      webhookUrl: z.string().url().optional(),
    }).default({}),
  }).default({}),
  githubIssues: z.boolean().default(true),
  checkRuns:    z.boolean().default(true),
  prComments:   z.boolean().default(true),
}).default({});

export type CyclopsConfig = z.infer<typeof CyclopsConfigSchema>;
