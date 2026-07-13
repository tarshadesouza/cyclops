import type { DetectorResult, Violation } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';

const BUILD_FAILURE_ANCHORS: RegExp[] = [
  /error TS\d+:/,
  /BUILD FAILED/,
  /FAILED: /,
  /\berror\b.*\.(?:swift|m|mm):/i,
  /^.*: error: /m,
  /can't load package:/i,
  /build failed with \d+ error/i,
];

export function detectBuildFailure(input: DetectorInput): DetectorResult {
  const lines = input.logExcerpt.split('\n');
  const violations: Violation[] = [];

  for (const line of lines) {
    for (const anchor of BUILD_FAILURE_ANCHORS) {
      if (anchor.test(line)) {
        violations.push({ message: line.trim() });
        break;
      }
    }
  }

  return {
    detectorType: 'BuildFailure',
    matched: violations.length > 0,
    violations,
    rawExcerpt: input.logExcerpt,
  };
}
