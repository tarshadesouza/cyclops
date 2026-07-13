// @ciintel/core — shared types, I/O-free
export type InstallationId = number;
export type TenantContext = {
  installationId: InstallationId;
};

export type DetectorType =
  | 'Lint'
  | 'FlakyTest'
  | 'BuildFailure'
  | 'TestFailure'
  | 'MissingEnvVar'
  | 'ExpiredSecret'
  | 'Unknown';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type Violation = {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
};

export type DetectorResult = {
  detectorType: DetectorType;
  matched: boolean;
  violations: Violation[];
  rawExcerpt: string;
};

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
