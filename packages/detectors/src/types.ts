// Re-export shared types from @cyclops/core
export type { DetectorType, DetectorResult, Violation } from '@cyclops/core';

import type { DetectorType, DetectorResult, DetectorContext } from '@cyclops/core';

export type CheckRunHistoryEntry = { conclusion: string | null };

// DetectorInput is an alias for the public DetectorContext — detector files remain unchanged
export type DetectorInput = DetectorContext;

export function notMatched(detectorType: DetectorType): DetectorResult {
  return { detectorType, matched: false, violations: [], rawExcerpt: '' };
}
