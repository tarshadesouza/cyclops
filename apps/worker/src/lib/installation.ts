import { getDb } from "@cyclops/db";
import type { Logger } from "pino";

export type InstallationCheckResult =
  | { active: true }
  | { active: false; reason: "suspended" | "deleted" | "not_found" };

/**
 * TEN-04: Check if installation is active before processing any job.
 * Called at the start of every worker job — never skip this check.
 */
export async function checkInstallationActive(
  installationId: number,
  logger: Logger
): Promise<InstallationCheckResult> {
  const db = getDb();

  const installation = await db.installation.findUnique({
    where: { id: installationId },
    select: { suspended: true, deletedAt: true },
  });

  if (!installation) {
    logger.warn({ installationId }, "Installation not found — dropping job");
    return { active: false, reason: "not_found" };
  }

  if (installation.deletedAt) {
    logger.info({ installationId }, "Installation deleted — dropping job");
    return { active: false, reason: "deleted" };
  }

  if (installation.suspended) {
    logger.info({ installationId }, "Installation suspended — dropping job");
    return { active: false, reason: "suspended" };
  }

  return { active: true };
}
