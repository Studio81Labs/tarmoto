import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import {
  getFeatureLimit,
  isFeatureEnabled,
  minLimit,
  resolveLimit,
  type LimitFeatureKey,
  type SubscriptionTier,
  type ToggleFeatureKey,
} from "@tarmoto/shared";
import { api } from "@/lib/api";
import type { UserProfileResponse } from "@/lib/api/users";
import { useAuthStore } from "@/stores/auth";

export const USERS_ME_QUERY_KEY = (userId: string | null) =>
  ["users-me", userId] as const;

/** Public global limit-override map (`GET /config/limits`) — served without
 *  auth, so it's the launch-mode source for anonymous / public surfaces where
 *  the auth-scoped `/users/me` snapshot never resolves. */
export const CONFIG_LIMITS_QUERY_KEY = ["config-limits"] as const;

/**
 * The operator's global override for a limit key, from the PUBLIC
 * `/config/limits` map. `undefined` = the key is ABSENT (no override → the
 * limit resolves normally); `null` = an explicit unlimited override; a number =
 * an explicit cap. Needs no auth, so it resolves for logged-out visitors.
 */
function useGlobalLimit(key: LimitFeatureKey): {
  override: number | null | undefined;
  isSuccess: boolean;
} {
  const query = useQuery({
    queryKey: CONFIG_LIMITS_QUERY_KEY,
    staleTime: 60_000,
    // This map is the ENFORCEMENT source for anonymous/public surfaces (the
    // `/explore` overlay), so a long-lived logged-out session must pick up an
    // operator activating or tightening a cap without a reload. `staleTime`
    // alone can't: the app-wide client disables refetch-on-focus and nothing
    // else invalidates this key. Poll while the tab is active (default:
    // `refetchIntervalInBackground` false → no background wakeups) and refetch
    // when the visitor returns to the tab, overriding the app default.
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/config/limits", {
        signal,
      });
      if (error || !data) throw new Error("Failed to load global limits");
      return data;
    },
  });
  const map = query.data ?? null;
  return {
    override: map && Object.hasOwn(map, key) ? (map[key] ?? null) : undefined,
    isSuccess: query.isSuccess,
  };
}

/**
 * The resolved `road_quality_max_zoom` cap for BOTH authenticated riders and
 * anonymous public viewers (the road-quality overlay renders on the public
 * `/explore` showcase). Authenticated → the `/users/me` snapshot, which already
 * folds in the global override. Anonymous → the auth-scoped query is disabled
 * and never resolves, so resolve from scratch against the PUBLIC global
 * override: the free-tier default replaced by the operator override. That keeps
 * the launch-mode `NULL` seed UNLIMITED (dark) for logged-out viewers instead
 * of fail-closing them to the free cap, and post-launch an anonymous viewer
 * resolves to the free-tier cap like any free user.
 */
export function useRoadQualityZoomCap(): {
  limit: number | null;
  isResolved: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const authed = userId != null;
  // NextAuth's session status distinguishes a CONFIRMED anonymous visitor
  // ("unauthenticated") from the pre-auth hydration window ("loading" — and the
  // brief gap where the session is "authenticated" but `AuthSync` hasn't copied
  // the user into the store yet, so `userId` is still null). During that window
  // a signed-in rider transiently looks anonymous; resolving the anonymous cap
  // then could render quality ABOVE their per-user override until `/users/me`
  // hydrates. Only the store-backed `authed` state or a settled "unauthenticated"
  // status is trustworthy here.
  const { status } = useSession();
  const { limit: userLimit, isSuccess: userResolved } = useLimit(
    "road_quality_max_zoom",
  );
  const { override, isSuccess: globalResolved } = useGlobalLimit(
    "road_quality_max_zoom",
  );

  // The cached /users/me snapshot folded in the operator's global override
  // SERVER-side, so when the operator changes/removes that override the profile
  // is stale until it refetches. That's the whole monetization go-live
  // transition: the launch-mode `null` override is deleted, polling flips
  // `override` to `undefined`, and the authed branch below falls back to the
  // cached `userLimit` — still unlimited — leaving a signed-in free rider on an
  // active tab with unlimited detail indefinitely (anonymous viewers already
  // clamp via /config/limits). Detecting the override CHANGE forces the profile
  // to re-resolve against the new operator state.
  //
  // We `resetQueries` rather than `invalidateQueries`: invalidate keeps the
  // stale successful snapshot (`userLimit: null`) in cache and refetches in the
  // background, so `bothResolved` stays true and the overlay keeps rendering
  // unlimited until the refetch settles. Reset clears the snapshot, so the
  // profile reads UNRESOLVED during the refetch and the branches below fail
  // closed to the free/known cap until the new value lands.
  const queryClient = useQueryClient();
  const lastOverrideRef = useRef<{ value: number | null | undefined } | null>(
    null,
  );
  useEffect(() => {
    if (!authed || !globalResolved) return;
    const prev = lastOverrideRef.current;
    lastOverrideRef.current = { value: override };
    if (prev !== null && prev.value !== override) {
      void queryClient.resetQueries({
        queryKey: USERS_ME_QUERY_KEY(userId),
      });
    }
  }, [authed, globalResolved, override, userId, queryClient]);

  // The strictest FINITE cap already known from either source (or null if none
  // is). Used while UNRESOLVED so hydration — or a background refetch that
  // failed but left the last-good value CACHED — clamps to the known
  // operator/user cap instead of widening to the free-tier fallback
  // (`resolveQualityLayerMaxZoom` clamps it further to the free cap). A finite
  // `userLimit`/`override` is a known clamp whether or not the latest fetch
  // succeeded, so this does NOT gate on `*Resolved`: an outage must not weaken
  // an operator cap we already have. `null`/`undefined` — unlimited / no
  // override / never loaded — are not finite caps, so they stay unknown.
  const knownWhileUnresolved = ((): number | null => {
    let cap: number | null = null;
    if (typeof userLimit === "number") cap = userLimit;
    if (typeof override === "number") {
      cap = cap === null ? override : Math.min(cap, override);
    }
    return cap;
  })();

  if (authed) {
    // The companion is the enforcement point for this overlay, so treat the cap
    // as resolved only once BOTH the profile AND the public override have
    // loaded — otherwise a stale /users/me (null / higher cap) that resolves
    // first would render quality detail ABOVE an operator's finite clamp until
    // /config/limits arrives. Fail closed (unresolved) until both.
    const bothResolved = userResolved && globalResolved;
    if (bothResolved) {
      // Apply the PUBLIC global override as a downward clamp over the cached
      // /users/me limit (never raises), so an operator's finite clamp takes
      // effect immediately rather than waiting for /users/me to refetch.
      const limit =
        override !== undefined ? minLimit(userLimit, override) : userLimit;
      return { limit, isResolved: true };
    }
    // Still hydrating one source: fail closed, but keep any restrictive cap
    // already in hand rather than rendering at the free fallback until the
    // other source loads.
    return { limit: knownWhileUnresolved, isResolved: false };
  }
  // Not (yet) authed. Until the session settles as unauthenticated, stay
  // fail-closed rather than resolve a permissive anonymous cap for a rider
  // whose auth is still hydrating — but preserve a known finite operator clamp
  // during that window instead of widening to the free default.
  if (status !== "unauthenticated") {
    return { limit: knownWhileUnresolved, isResolved: false };
  }
  // Confirmed anonymous but the public override isn't currently resolved (never
  // loaded, or a polling/focus refetch failed). Keep a finite cached override
  // rather than widening to free — an outage must not weaken an operator cap.
  if (!globalResolved) {
    return { limit: knownWhileUnresolved, isResolved: false };
  }
  // Confirmed anonymous: no tier → the registry free/default value, then the
  // global operator override replaces it (undefined = no override → free
  // default).
  return {
    limit: resolveLimit("road_quality_max_zoom", null, undefined, override),
    isResolved: true,
  };
}

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
  /** Force a re-fetch of the entitlement snapshot — for a client-enforced gate
   *  to offer an explicit RETRY after a lookup error, rather than failing open
   *  or stranding the user until the poll/focus refetch. */
  refetch: () => void;
  /** react-query's `dataUpdatedAt`: advances every time a fetch SUCCEEDS, even
   *  when the resolved value is byte-identical. Lets a caller detect that a
   *  fresh snapshot arrived (e.g. to clear a stale reactive upsell after a
   *  refetch confirms the feature is still/again granted) when the enabled flag
   *  itself never changes. */
  dataUpdatedAt: number;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const query = useQuery({
    queryKey: USERS_ME_QUERY_KEY(userId),
    enabled: userId != null,
    refetchOnWindowFocus: true,
    // Poll while the tab is active (default: no background wakeups) so the
    // server-resolved snapshot can't go stale INDEFINITELY on a continuously
    // focused tab. `/users/me` is the source for CLIENT-enforced entitlements —
    // the in-browser GPX export (`gpx_export` toggle) and the road-quality zoom
    // overlay — so without this an operator revoking a flag/limit (removing a
    // launch override, or a `force_off`) would not take effect until a window
    // refocus or remount that may never happen while the rider keeps exporting
    // or panning. Refocus is still handled by `refetchOnWindowFocus`; the map
    // path additionally resets this query the instant it detects a
    // `/config/limits` override change (see `useRoadQualityZoomCap`).
    refetchInterval: 5 * 60_000,
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
    refetch: () => void query.refetch(),
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

/** Whether a tier-locked toggle is granted. `enabled` is false while loading
 *  or unknown — callers that must avoid a locked-state flash should gate on
 *  `isLoading`, and those that must fail closed on an unresolved snapshot
 *  (e.g. the auth-hydration window where the query is disabled: `isLoading`
 *  false but `isSuccess` false) should gate on `isSuccess`. `isError` lets a
 *  caller distinguish a genuine lookup FAILURE from "still loading" so it can
 *  offer a retry / defer to a server-authoritative action instead of blocking
 *  indefinitely. */
export function useFeature(key: ToggleFeatureKey): {
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  /** See `useEntitlements.dataUpdatedAt`. */
  dataUpdatedAt: number;
} {
  const { features, isLoading, isError, isSuccess, dataUpdatedAt } =
    useEntitlements();
  return {
    enabled: features ? isFeatureEnabled(features, key) : false,
    isLoading,
    isError,
    isSuccess,
    dataUpdatedAt,
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
