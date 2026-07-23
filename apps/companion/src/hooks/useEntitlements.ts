import { useQuery } from "@tanstack/react-query";
import {
  getFeatureLimit,
  isFeatureEnabled,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { api } from "@/lib/api";
import type { UserProfileResponse } from "@/lib/api/users";
import { useAuthStore } from "@/stores/auth";

export const USERS_ME_QUERY_KEY = (userId: string | null) =>
  ["users-me", userId] as const;

/**
 * Single source of truth for the rider's resolved entitlements. Reads the
 * cached `GET /users/me` response (server-resolved `features`/`limits` — global
 * overrides already applied) and refetches on window focus so an upgrade taken
 * in another tab lands promptly. UI code consumes the derived hooks below, not
 * this snapshot directly.
 */
export function useEntitlements(): {
  tier: SubscriptionTier | null;
  features: UserProfileResponse["features"] | null;
  limits: UserProfileResponse["limits"] | null;
  isLoading: boolean;
  /** The entitlement query settled in error — the snapshot is unknown, not
   *  "resolved to unlimited". Callers gating access must fail closed on this. */
  isError: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const query = useQuery({
    queryKey: USERS_ME_QUERY_KEY(userId),
    enabled: userId != null,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/users/me", { signal });
      if (error || !data) throw new Error("Failed to load entitlements");
      return data;
    },
  });
  const data = query.data ?? null;
  return {
    tier: data?.subscription_tier ?? null,
    features: data?.features ?? null,
    limits: data?.limits ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Whether a tier-locked toggle is granted. `enabled` is false while loading
 *  or unknown — callers that must avoid a locked-state flash should gate on
 *  `isLoading`. */
export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isLoading: boolean;
} {
  const { features, isLoading } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isLoading,
  };
}

/** The resolved numeric limit. `null` means unlimited ONLY when the whole
 *  snapshot is still unresolved (callers gate on `isLoading`) or the key is
 *  present with an explicit `null` value. A key MISSING from a resolved
 *  snapshot (partial deploy, stale cached shape, a limit consumed before the
 *  DTO ships it) falls back to the shared restrictive default (`0`) rather than
 *  unlimited — fail closed on an unknown cap, since the backend will reject. */
export function useLimit(key: LimitFeatureKey): {
  limit: number | null;
  isLoading: boolean;
  isError: boolean;
} {
  const { limits, isLoading, isError } = useEntitlements();
  return {
    limit: limits ? getFeatureLimit(limits, key) : null,
    isLoading,
    isError,
  };
}
