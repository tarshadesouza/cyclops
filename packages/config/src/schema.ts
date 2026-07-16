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
  // autofixMode controls WHERE a fix lands when the "Implement fix" button is
  // pressed (or the loop applies a fix):
  //   "locked"  → fix goes on a separate cyclops/autofix/* branch and opens a PR
  //               for review (safe default, works even when autofix is OFF).
  //   "autofix" → fix is committed DIRECTLY to the PR's own head branch.
  //               "A little wild" — surface a setup disclaimer before enabling.
  autofixMode:         z.enum(["locked", "autofix"]).default("locked"),
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
