import type { MarketplacePurchaseJob } from "@cyclops/queue";

export type BillingStatus = "trial" | "active" | "suspended" | "cancelled";

/**
 * Derive the next billingStatus and related fields from a marketplace event.
 */
export function deriveTransition(job: MarketplacePurchaseJob): {
  billingStatus: BillingStatus;
  trialEndsAt: Date | null;
  billingCancelAt: Date | null;
  marketplacePlanId: number;
  marketplacePlanName: string;
} {
  const now = new Date();
  const effectiveDate = new Date(job.effectiveDate);

  if (job.eventType === "marketplace_purchase") {
    if (job.onFreeTrial && job.freeTrialEndsOn) {
      return {
        billingStatus: "trial",
        trialEndsAt: new Date(job.freeTrialEndsOn),
        billingCancelAt: null,
        marketplacePlanId: job.planId,
        marketplacePlanName: job.planName,
      };
    }
    return {
      billingStatus: "active",
      trialEndsAt: null,
      billingCancelAt: null,
      marketplacePlanId: job.planId,
      marketplacePlanName: job.planName,
    };
  }

  if (job.eventType === "marketplace_plan_changed") {
    return {
      billingStatus: "active",
      trialEndsAt: null,
      billingCancelAt: null,
      marketplacePlanId: job.planId,
      marketplacePlanName: job.planName,
    };
  }

  // marketplace_purchase_cancelled
  if (effectiveDate <= now) {
    return {
      billingStatus: "cancelled",
      trialEndsAt: null,
      billingCancelAt: effectiveDate,
      marketplacePlanId: job.planId,
      marketplacePlanName: job.planName,
    };
  }
  // Future effective date — store billingCancelAt, keep status unchanged.
  // Caller must NOT overwrite billingStatus when effectiveDate is in the future.
  return {
    billingStatus: "trial", // placeholder — caller uses update that only sets billingCancelAt
    trialEndsAt: null,
    billingCancelAt: effectiveDate,
    marketplacePlanId: job.planId,
    marketplacePlanName: job.planName,
  };
}

/**
 * Lazy billing expiry check — called from checkInstallationActive.
 * Returns the billing status that SHOULD apply right now given stored dates.
 * Returns null if no change is needed.
 */
export function getExpiredBillingStatus(
  billingStatus: string,
  trialEndsAt: Date | null,
  billingCancelAt: Date | null
): "suspended" | "cancelled" | null {
  const now = new Date();

  if (billingStatus === "cancelled" || billingStatus === "suspended") {
    return null; // already terminal
  }

  if (billingCancelAt && billingCancelAt <= now) {
    return "cancelled";
  }

  if (billingStatus === "trial" && trialEndsAt && trialEndsAt <= now) {
    return "suspended";
  }

  return null;
}
