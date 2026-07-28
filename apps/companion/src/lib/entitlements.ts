import { ApiError } from "@/lib/api";
import type { EnglishMessageKey } from "@/i18n";
import {
  FEATURE_LIMIT_EXCEEDED,
  type LimitFeatureKey,
  type SubscriptionTier,
} from "@tarmoto/shared";

const TIER_LABEL: Record<SubscriptionTier, EnglishMessageKey> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};

/** Catalog key for a subscription tier. */
export function tierLabel(tier: SubscriptionTier): EnglishMessageKey {
  return TIER_LABEL[tier];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The authoritative limit context carried on the backend's
 *  `featureLimitExceeded` 403 body. */
export interface FeatureLimitError {
  feature: LimitFeatureKey;
  /** The resolved cap the backend enforced — authoritative even when the
   *  client's cached `/users/me` snapshot is stale. */
  limit: number;
  current: number;
}

/** Parse the backend's `featureLimitExceeded` rejection (403 +
 *  `code: FEATURE_LIMIT_EXCEEDED`) into its feature/limit/current context, or
 *  null for any other error. Callers feed `limit` into the upgrade modal so the
 *  CTA reflects the cap the server actually enforced, not a stale cached one. */
export function parseFeatureLimitError(
  error: unknown,
): FeatureLimitError | null {
  if (
    error instanceof ApiError &&
    error.status === 403 &&
    isRecord(error.body) &&
    error.body.code === FEATURE_LIMIT_EXCEEDED &&
    typeof error.body.feature === "string" &&
    typeof error.body.limit === "number" &&
    typeof error.body.current === "number"
  ) {
    return {
      feature: error.body.feature as LimitFeatureKey,
      limit: error.body.limit,
      current: error.body.current,
    };
  }
  return null;
}

/** Boolean convenience over {@link parseFeatureLimitError}. */
export function isFeatureLimitError(error: unknown): boolean {
  return parseFeatureLimitError(error) !== null;
}

/** True for a plain toggle-gate rejection (a `FeatureGuard`/inline
 *  `ForbiddenException`, message `"Feature unavailable: <key>"`) — the shape
 *  SP1 uses for boolean feature toggles, as opposed to the structured
 *  `FEATURE_LIMIT_EXCEEDED` body {@link parseFeatureLimitError} parses for
 *  numeric limits. There is no `code`/`feature` field to key off, so this is a
 *  reactive-net catch-all: any 403 that ISN'T a recognized limit rejection is
 *  treated as a toggle-forbidden response. */
export function isFeatureForbiddenError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    !isFeatureLimitError(error)
  );
}
