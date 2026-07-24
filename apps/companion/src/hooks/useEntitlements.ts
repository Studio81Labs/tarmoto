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
  /** The query has actually SUCCEEDED and produced a snapshot. Gating callers
   *  must fail closed until this is true: a not-yet-started query (auth store
   *  not hydrated → `userId` null → query disabled) reports `isLoading:false` +
   *  `isError:false` yet is NOT resolved — treating that as "unlimited" would
   *  reopen mint controls during the auth-hydration window. */
  isSuccess: boolean;
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
    isSuccess: query.isSuccess,
  };
}

/** Whether a tier-locked toggle is granted. `enabled` is false while loading
 *  or unknown — callers that must avoid a locked-state flash should gate on
 *  `isLoading`, and those that must fail closed on an unresolved snapshot
 *  (e.g. the auth-hydration window where the query is disabled: `isLoading`
 *  false but `isSuccess` false) should gate on `isSuccess`. */
export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isLoading: boolean;
  isSuccess: boolean;
} {
  const { features, isLoading, isSuccess } = useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isLoading,
    isSuccess,
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
  /** The cap has actually resolved (query succeeded). Gate callers must fail
   *  closed until this is true — see `useEntitlements`. */
  isSuccess: boolean;
} {
  const { limits, isLoading, isError, isSuccess } = useEntitlements();
  return {
    limit: limits ? getFeatureLimit(limits, key) : null,
    isLoading,
    isError,
    // A successful response that OMITS the whole `limits` object (a rolling
    // deploy where the profile pod still serves the pre-limits DTO while
    // mint endpoints already enforce caps) is an UNKNOWN cap, not "resolved
    // unlimited". Report not-resolved so gate callers fail closed rather than
    // reading the absent snapshot as null/unlimited.
    isSuccess: isSuccess && limits !== null,
  };
}
