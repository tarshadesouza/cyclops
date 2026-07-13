import type { DetectorResult, Violation } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';

const MISSING_ENV_VAR_PATTERNS = [
  /\$\{?(\w+)\}?\s*(?:is not set|is undefined|: unbound variable)/i,
  /environment variable\s+[`'"]([\w_]+)[`'"]\s+(?:is )?(?:not set|undefined|missing)/i,
  /Error: Missing required environment variable[:\s]+[`'"]([\w_]+)[`'"]/i,
  /getenv\([`'"]([\w_]+)[`'"]\)\s*(?:returned|is)\s+(?:null|empty|undefined)/i,
  /KeyError:\s+[`'"]([\w_]+)[`'"]/i,
  /Cannot find env var[:\s]+[`'"]([\w_]+)[`'"]/i,
  /process\.env\.([\w_]+)\s+is undefined/i,
];

export function detectMissingEnvVar(input: DetectorInput): DetectorResult {
  const lines = input.logExcerpt.split('\n');
  const violations: Violation[] = [];

  for (const line of lines) {
    for (const pattern of MISSING_ENV_VAR_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        violations.push({
          message: line.trim(),
          rule: match[1] ?? undefined,
        });
        break;
      }
    }
  }

  if (violations.length === 0) return notMatched('MissingEnvVar');

  return {
    detectorType: 'MissingEnvVar',
    matched: true,
    violations,
    rawExcerpt: input.logExcerpt,
  };
}
