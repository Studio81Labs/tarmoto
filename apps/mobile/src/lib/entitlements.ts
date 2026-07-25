import { FEATURE_LIMIT_EXCEEDED, type SubscriptionTier } from "@tarmoto/shared";
import { ApiError } from "@/services/api";
import type { EnglishMessageKey } from "@/i18n/locales";

/** The owner-scoped numeric cap 403 (code FEATURE_LIMIT_EXCEEDED). NOT the
 *  toggle feature-guard 403 ("Feature unavailable: <key>", no code). */
export function isFeatureLimitError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    (err.body as { code?: string } | null)?.code === FEATURE_LIMIT_EXCEEDED
  );
}

const TIER_LABELS: Record<SubscriptionTier, EnglishMessageKey> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

export function tierLabel(
  tier: SubscriptionTier,
  t: (k: EnglishMessageKey) => string,
): string {
  return t(TIER_LABELS[tier]);
}
