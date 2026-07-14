// Detector contract types — public SDK surface

export type DetectorType =
  | 'Lint'
  | 'FlakyTest'
  | 'BuildFailure'
  | 'TestFailure'
  | 'MissingEnvVar'
  | 'ExpiredSecret'
  | 'Unknown';

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

export type DetectorContext = {
  logExcerpt: string;
  workflowYaml: string;
  jobName: string;
  checkRunHistory?: { conclusion: string | null }[];
};

export interface IDetector {
  readonly detectorType: DetectorType;
  detect(context: DetectorContext): DetectorResult;
}
