import type { SubscriptionTier } from "@tarmoto/shared";
import type { EnglishMessageKey } from "@/i18n/locales";
import type { User } from "@/types";

/**
 * Overlay the entitlement slices (`subscription_tier` / `features` / `limits`)
 * from `current` onto an `incoming` full-profile response.
 *
 * Entitlements are server-controlled and single-writer: only the entitlement
 * refresh path (and the cold-start baseline) should mutate them in the store.
 * Any OTHER profile publisher — a preferences PATCH, an avatar upload — returns
 * a full profile whose entitlement snapshot was computed at request time and
 * can be STALE relative to a concurrent foreground refresh. Publishing it whole
 * would let an incidental profile write resurrect a just-revoked capability
 * (re-enabling GPX export or z22 quality) until the next refresh. Preserving the
 * store's current slices keeps entitlements owned by the refresh path alone.
 *
 * With no current user (first publish establishes the baseline) the incoming
 * profile is returned unchanged.
 *
 * The tier/features/limits tuple is preserved ATOMICALLY — all three or none.
 * An upgraded install's cached profile can predate these fields (they're
 * `undefined` at runtime despite the DTO typing them required); an older shape
 * even carried tier+features but NOT `limits` (numeric limits shipped later).
 * A per-slice fallback would then splice a stale `features` (e.g.
 * `gpx_export: true`) onto the incoming `limits`, yielding an incoherent
 * half-old/half-new entitlement state that keeps a revoked capability alive.
 * So: preserve the current tuple only when the current snapshot is COMPLETE
 * (all three present); otherwise it's legacy/partial and we take the whole
 * tuple from the incoming server-computed response.
 */
export function withPreservedEntitlements(
  current: User | null,
  incoming: User,
): User {
  if (!current) return incoming;
  // The DTO types these as required, but a legacy cached profile may lack them
  // at runtime — read through an optional view to test presence honestly.
  const cur = current as {
    subscription_tier?: User["subscription_tier"];
    features?: User["features"];
    limits?: User["limits"];
  };
  const currentIsComplete =
    cur.subscription_tier != null && cur.features != null && cur.limits != null;
  if (!currentIsComplete) return incoming;
  return {
    ...incoming,
    subscription_tier: current.subscription_tier,
    features: current.features,
    limits: current.limits,
  };
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
