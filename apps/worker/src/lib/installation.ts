import { getDb } from "@cyclops/db";
import type { Logger } from "pino";
import { getExpiredBillingStatus } from "./billing-state.js";

export type InstallationCheckResult =
  | { active: true }
  | { active: false; reason: "suspended" | "deleted" | "not_found" | "billing_expired" | "billing_cancelled" };

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
    select: {
      suspended: true,
      deletedAt: true,
      billingStatus: true,
      trialEndsAt: true,
      billingCancelAt: true,
    },
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

  // Lazy billing expiry: check whether trial or cancellation date has passed
  const expiredStatus = getExpiredBillingStatus(
    installation.billingStatus,
    installation.trialEndsAt,
    installation.billingCancelAt
  );
  if (expiredStatus) {
    await db.installation.update({
      where: { id: installationId },
      data: { billingStatus: expiredStatus },
    });
    logger.info({ installationId, expiredStatus }, "Billing status expired — suspending jobs");
    return {
      active: false,
      reason: expiredStatus === "cancelled" ? "billing_cancelled" : "billing_expired",
    };
  }

  if (installation.billingStatus === "suspended" || installation.billingStatus === "cancelled") {
    logger.info({ installationId, billingStatus: installation.billingStatus }, "Installation billing inactive — dropping job");
    return { active: false, reason: "billing_expired" };
  }

  return { active: true };
}
