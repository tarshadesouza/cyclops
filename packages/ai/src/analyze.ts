import { generateObject, NoObjectGeneratedError } from 'ai';  // top-level 'ai' only — NOT subpaths
import { FindingSchema, type FindingOutput } from './schema.js';
import { createAnthropicForInstallation, CLAUDE_MODEL } from './client.js';
import type { DetectorType } from '@ciintel/core';

const SYSTEM_PROMPT = `You are a CI/CD failure analyst. You receive CI log excerpts and classify failures.
Always provide specific evidence from the log. Never invent violations not present in the log.
If uncertain, set confidence below 0.6 and explain in caveat.`;

function buildPrompt(logExcerpt: string, detectorType: string): string {
  return `Detector pre-classification: ${detectorType}

CI Log Excerpt:
\`\`\`
${logExcerpt}
\`\`\`

Analyze this failure. Extract specific evidence lines from the log.
Set confidence based on how clearly the log demonstrates the failure type.
Evidence must be direct quotes from the log, not paraphrases.`;
}

export type AnalyzeInput = {
  logExcerpt: string;
  detectorType: DetectorType;
  apiKey: string;
};

export type AnalyzeResult = {
  output: FindingOutput;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};

export async function analyzeFailure(input: AnalyzeInput): Promise<AnalyzeResult> {
  const anthropic = createAnthropicForInstallation(input.apiKey);

  try {
    const { object, usage } = await generateObject({
      model: anthropic(CLAUDE_MODEL),
      schema: FindingSchema,
      schemaName: 'CIFailureFinding',
      schemaDescription: 'Structured analysis of a CI failure',
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input.logExcerpt, input.detectorType),
      maxRetries: 2,
    });

    // ai@7 renamed promptTokens → inputTokens, completionTokens → outputTokens
    return {
      output: object,
      usage: {
        promptTokens:     usage.inputTokens     ?? 0,
        completionTokens: usage.outputTokens    ?? 0,
        totalTokens:      usage.totalTokens     ?? 0,
      },
    };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      // err.usage available even on failure — do NOT swallow
      throw err;
    }
    throw err;
  }
}
