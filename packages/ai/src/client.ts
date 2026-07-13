import { createAnthropic } from '@ai-sdk/anthropic';

export function createAnthropicForInstallation(apiKey: string) {
  return createAnthropic({ apiKey });
}

export const CLAUDE_MODEL = 'claude-sonnet-5';
