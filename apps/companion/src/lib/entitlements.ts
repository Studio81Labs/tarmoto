import { ApiError } from "@/lib/api";
import { FEATURE_LIMIT_EXCEEDED, type SubscriptionTier } from "@tarmoto/shared";

const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

/** Display name for a subscription tier (English-only until i18n covers it). */
export function tierLabel(tier: SubscriptionTier): string {
  return TIER_LABEL[tier];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True for the backend's `featureLimitExceeded` rejection (403 +
 *  `code: FEATURE_LIMIT_EXCEEDED`) so mint paths can surface the upgrade
 *  prompt instead of a generic error. */
export function isFeatureLimitError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    isRecord(error.body) &&
    error.body.code === FEATURE_LIMIT_EXCEEDED
  );
}
