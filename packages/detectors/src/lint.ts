import type { DetectorResult, Violation } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';
import { inferLinterFromWorkflow } from './log-utils.js';

const LINTER_VIOLATION_PATTERNS: Record<string, RegExp> = {
  ESLint:    /^(.+\.(?:js|ts|jsx|tsx|mjs|cjs)):(\d+):(\d+):\s+(error|warning)\s+(.+)\s+([\w/-]+)$/m,
  SwiftLint: /^(.+\.swift):(\d+):(\d+):\s+(error|warning):\s+(.+)\s+\((\w+)\)$/m,
  ktlint:    /^(.+\.kt):(\d+):(\d+):\s+(.+)$/m,
  Rubocop:   /^(.+\.rb):(\d+):(\d+):\s+[CWE]:\s+(.+):\s+(.+)$/m,
  Prettier:  /^\[warn\]\s+(.+)$/m,
  Golangci:  /^(.+\.go):(\d+):(\d+):\s+(.+)\s+\((\w+)\)$/m,
};

export function detectLint(input: DetectorInput): DetectorResult {
  const linter = inferLinterFromWorkflow(input.workflowYaml);
  if (!linter) return notMatched('Lint');

  const pattern = LINTER_VIOLATION_PATTERNS[linter];
  const violations: Violation[] = [];

  if (pattern) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    const lines = input.logExcerpt.split('\n');

    for (const line of lines) {
      const match = line.match(pattern);
      if (!match) continue;

      if (linter === 'ESLint') {
        violations.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[5]?.trim() ?? '',
          rule: match[6]?.trim() ?? '',
        });
      } else if (linter === 'SwiftLint') {
        violations.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[5]?.trim() ?? '',
          rule: match[6]?.trim() ?? '',
        });
      } else if (linter === 'ktlint') {
        violations.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4]?.trim() ?? '',
        });
      } else if (linter === 'Rubocop') {
        violations.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          rule: match[4]?.trim() ?? '',
          message: match[5]?.trim() ?? '',
        });
      } else if (linter === 'Prettier') {
        violations.push({
          file: match[1]?.trim() ?? '',
          message: `Prettier format violation: ${match[1]?.trim() ?? ''}`,
        });
      } else if (linter === 'Golangci') {
        violations.push({
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          message: match[4]?.trim() ?? '',
          rule: match[5]?.trim() ?? '',
        });
      }
    }

    // Suppress unused variable for globalPattern
    void globalPattern;
  }

  return {
    detectorType: 'Lint',
    matched: violations.length > 0,
    violations,
    rawExcerpt: input.logExcerpt,
  };
}
