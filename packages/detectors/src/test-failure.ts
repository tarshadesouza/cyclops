import type { DetectorResult } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';
import { TEST_FAILURE_PATTERNS } from './flaky-test.js';

export function detectTestFailure(input: DetectorInput): DetectorResult {
  const hasTestFailure = TEST_FAILURE_PATTERNS.some(p => p.test(input.logExcerpt));
  if (!hasTestFailure) return notMatched('TestFailure');

  const history = input.checkRunHistory ?? [];
  const allFailed = history.every(h => h.conclusion === 'failure');
  const isNewFailure = history.length === 0 || allFailed;

  return { detectorType: 'TestFailure', matched: isNewFailure, violations: [], rawExcerpt: input.logExcerpt };
}
