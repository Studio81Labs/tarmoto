import {
  getFeatureLimit,
  isFeatureEnabled,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { useAuthStore } from "@/stores";
import type { User } from "@/types";

/** The server-resolved entitlement snapshot (already cached in the auth store,
 *  refreshed on launch by authBootstrap). Resolution requires a POSITIVE
 *  snapshot, not merely a signed-in user: a legacy cached profile serialized
 *  before the `features`/`limits` fields existed hydrates as a non-null `User`
 *  with those fields undefined at runtime, and if the `/users/me` refresh then
 *  fails we must fail closed rather than read the absent snapshot as unlimited.
 *  So `isResolved` derives from the snapshot slices being present, and the
 *  specialized hooks below gate on their OWN slice — `useFeature` on `features`,
 *  `useLimit` on `limits` — so a missing slice can only lower, never raise, what
 *  a gate exposes. `isResolved` here is the conjunction (both slices present)
 *  for any consumer that needs the whole snapshot. */
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: User["features"] | null;
  limits: User["limits"] | null;
  isResolved: boolean;
} {
  const user = useAuthStore((s) => s.user);
  const features = user?.features ?? null;
  const limits = user?.limits ?? null;
  return {
    tier: (user?.subscription_tier as SubscriptionTier | undefined) ?? null,
    features,
    limits,
    isResolved: features != null && limits != null,
  };
}

export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isResolved: boolean;
} {
  const { features } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isResolved: features != null,
  };
}

export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isResolved: boolean;
} {
  const { limits } = useEntitlements();
  return {
    limit: limits ? getFeatureLimit(limits, key) : null,
    isResolved: limits != null,
  };
}
