import { z } from 'zod';

export const FindingSchema = z.object({
  confidence:    z.number().min(0).max(1),
  evidence:      z.array(z.string()).min(1),
  caveat:        z.string(),
  rootCause:     z.string(),
  suggestedFix:  z.string(),
  affectedFiles: z.array(z.string()),
  severity:      z.enum(['critical', 'high', 'medium', 'low']),
  detectorType:  z.enum(['Lint', 'FlakyTest', 'BuildFailure', 'TestFailure', 'MissingEnvVar', 'ExpiredSecret', 'Unknown']),
});

export type FindingOutput = z.infer<typeof FindingSchema>;
