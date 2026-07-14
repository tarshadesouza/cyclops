// @cyclops/core — shared types, I/O-free
export * from './detector.js';
import type { DetectorType } from './detector.js';

export type InstallationId = number;
export type TenantContext = {
  installationId: InstallationId;
};

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type AiFinding = {
  confidence: number;
  evidence: string[];
  caveat: string;
  rootCause: string;
  suggestedFix: string;
  affectedFiles: string[];
  severity: FindingSeverity;
  detectorType: DetectorType;
};
