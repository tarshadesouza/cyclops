import type { DetectorResult, Violation } from './types.js';
import { notMatched } from './types.js';
import type { DetectorInput } from './types.js';

const EXPIRED_SECRET_PATTERNS = [
  /certificate\s+(?:has\s+)?expired/i,
  /provisioning profile\s+(?:has\s+)?expired/i,
  /code signing\s+(?:identity|certificate)\s+(?:has\s+)?expired/i,
  /Apple Development.*(?:expired|invalid)/i,
  /api.?key\s+(?:has\s+)?expired/i,
  /token\s+(?:has\s+)?expired/i,
  /your\s+(?:api\s+)?key\s+(?:has\s+)?(?:expired|been revoked)/i,
  /ExpiredTokenException/i,
  /InvalidClientTokenId/i,
  /The security token included in the request is expired/i,
  /credential\s+(?:has\s+)?expired/i,
  /401\s+Unauthorized.*(?:token|key|credential)/i,
];

export function detectExpiredSecret(input: DetectorInput): DetectorResult {
  const lines = input.logExcerpt.split('\n');
  const violations: Violation[] = [];

  for (const line of lines) {
    for (const pattern of EXPIRED_SECRET_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ message: line.trim() });
        break;
      }
    }
  }

  if (violations.length === 0) return notMatched('ExpiredSecret');

  return {
    detectorType: 'ExpiredSecret',
    matched: true,
    violations,
    rawExcerpt: input.logExcerpt,
  };
}
