// Public surface — types, utils, all detectors, orchestrator
export type { DetectorType, DetectorResult, Violation, CheckRunHistoryEntry, DetectorInput } from './types.js';
export { notMatched } from './types.js';
export { stripLogFormatting, extractExcerpt, inferLinterFromWorkflow } from './log-utils.js';

export { detectLint } from './lint.js';
export { detectBuildFailure } from './build-failure.js';
export { detectMissingEnvVar } from './missing-env-var.js';
export { detectExpiredSecret } from './expired-secret.js';
export { detectFlakyTest, TEST_FAILURE_PATTERNS } from './flaky-test.js';
export { detectTestFailure } from './test-failure.js';

import type { DetectorInput, DetectorResult } from './types.js';
import { detectLint } from './lint.js';
import { detectBuildFailure } from './build-failure.js';
import { detectMissingEnvVar } from './missing-env-var.js';
import { detectExpiredSecret } from './expired-secret.js';
import { detectFlakyTest } from './flaky-test.js';
import { detectTestFailure } from './test-failure.js';

/**
 * Run all detectors in priority order.
 * FlakyTest and TestFailure are mutually exclusive — FlakyTest checked first.
 * Returns all matched DetectorResults; empty array means Unknown (caller substitutes).
 */
export function runAllDetectors(input: DetectorInput): DetectorResult[] {
  const results: DetectorResult[] = [];

  for (const detect of [detectLint, detectBuildFailure, detectMissingEnvVar, detectExpiredSecret]) {
    const r = detect(input);
    if (r.matched) results.push(r);
  }

  // FlakyTest before TestFailure — mutually exclusive
  const flaky = detectFlakyTest(input);
  if (flaky.matched) {
    results.push(flaky);
  } else {
    const testFail = detectTestFailure(input);
    if (testFail.matched) results.push(testFail);
  }

  return results; // empty array means Unknown — caller substitutes
}
