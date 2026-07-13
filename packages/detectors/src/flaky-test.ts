import type { DetectorResult } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';

export const TEST_FAILURE_PATTERNS = [
  /\d+ failing/i,
  /FAIL /,
  /✕/,
  /● .+ ›/,
  /AssertionError/i,
  /Test Suite.*failed/i,
  /tests? failed/i,
  /FAILED tests?/i,
];

export function detectFlakyTest(input: DetectorInput): DetectorResult {
  const hasTestFailure = TEST_FAILURE_PATTERNS.some(p => p.test(input.logExcerpt));
  if (!hasTestFailure) return notMatched('FlakyTest');

  const history = input.checkRunHistory ?? [];
  if (history.length === 0) return notMatched('FlakyTest'); // first-ever run — not flaky

  const passes = history.filter(h => h.conclusion === 'success').length;
  const fails  = history.filter(h => h.conclusion === 'failure').length;
  const isFlaky = passes >= 1 && fails >= 2;

  return { detectorType: 'FlakyTest', matched: isFlaky, violations: [], rawExcerpt: input.logExcerpt };
}
