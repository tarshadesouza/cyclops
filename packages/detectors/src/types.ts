// Re-export shared types from @cyclops/core
export type { DetectorType, DetectorResult, Violation } from '@cyclops/core';

import type { DetectorType, DetectorResult } from '@cyclops/core';

export type CheckRunHistoryEntry = { conclusion: string | null };

export type DetectorInput = {
  logExcerpt: string;
  workflowYaml: string;
  jobName: string;
  checkRunHistory?: CheckRunHistoryEntry[];
};

export function notMatched(detectorType: DetectorType): DetectorResult {
  return { detectorType, matched: false, violations: [], rawExcerpt: '' };
}
