import stripAnsi from 'strip-ansi';
import jsYaml from 'js-yaml';

const LINTER_PATTERNS: Record<string, RegExp> = {
  ESLint:    /\beslint\b/i,
  SwiftLint: /\bswiftlint\b/i,
  ktlint:    /\bktlint\b/i,
  Rubocop:   /\brubocop\b/i,
  Prettier:  /\bprettier\b.*--check\b|\bprettier:check\b/i,
  Flake8:    /\bflake8\b/i,
  Pylint:    /\bpylint\b/i,
  Golangci:  /\bgolangci-lint\b/i,
  Detekt:    /\bdetekt\b/i,
};

/**
 * Strip ISO timestamps and ANSI escape codes from log output.
 */
export function stripLogFormatting(log: string): string {
  const withoutTimestamps = log.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm, '');
  return stripAnsi(withoutTimestamps);
}

/**
 * Extract a window of lines around the first anchor match.
 * Falls back to the first 150 lines if no anchor found.
 */
export function extractExcerpt(
  log: string,
  anchorPattern: RegExp,
  windowLines = 75,
): string {
  const lines = log.split('\n');
  const anchorIdx = lines.findIndex(l => anchorPattern.test(l));

  const start = anchorIdx === -1 ? 0 : Math.max(0, anchorIdx - windowLines);
  const end = anchorIdx === -1
    ? Math.min(lines.length, 150)
    : Math.min(lines.length, anchorIdx + windowLines);

  return lines.slice(start, Math.min(end, start + 150)).join('\n');
}

type WorkflowYaml = {
  jobs?: Record<string, {
    steps?: Array<{ run?: string }>;
  }>;
};

function extractAllRunCommands(yaml: WorkflowYaml): string[] {
  const commands: string[] = [];
  if (!yaml.jobs) return commands;
  for (const job of Object.values(yaml.jobs)) {
    if (!job.steps) continue;
    for (const step of job.steps) {
      if (step.run) commands.push(step.run);
    }
  }
  return commands;
}

/**
 * Parse workflow YAML and infer the linter being used from run commands.
 * Returns the linter name or null if none detected.
 */
export function inferLinterFromWorkflow(yaml: string): string | null {
  try {
    const parsed = jsYaml.load(yaml) as WorkflowYaml;
    if (!parsed || typeof parsed !== 'object') return null;

    const commands = extractAllRunCommands(parsed);
    const combined = commands.join('\n');

    for (const [linter, pattern] of Object.entries(LINTER_PATTERNS)) {
      if (pattern.test(combined)) return linter;
    }
    return null;
  } catch {
    return null;
  }
}
