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
 *  refreshed on launch by authBootstrap). `isResolved` is false only when
 *  logged out — gating callers fail closed then. */
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: User["features"] | null;
  limits: User["limits"] | null;
  isResolved: boolean;
} {
  const user = useAuthStore((s) => s.user);
  return {
    tier: (user?.subscription_tier as SubscriptionTier | undefined) ?? null,
    features: user?.features ?? null,
    limits: user?.limits ?? null,
    isResolved: user != null,
  };
}

export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isResolved: boolean;
} {
  const { features, isResolved } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isResolved,
  };
}

export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isResolved: boolean;
} {
  const { limits, isResolved } = useEntitlements();
  return { limit: limits ? getFeatureLimit(limits, key) : null, isResolved };
}
