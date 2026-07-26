/**
 * Entitlement-driven decisions for `MapScreen`'s road-quality overlay.
 * Extracted so the clamp + visibility logic is unit-testable without
 * rendering the full screen (native MapLibre modules, sockets, stores).
 */
import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useLimit } from "@/hooks/useEntitlements";
import { useAuthStore } from "@/stores";
import { api } from "@/services/api";
import {
  clampQualityMaxZoom,
  resolveLimit,
  upgradeTierForLimit,
  type GlobalLimitOverrides,
  type SubscriptionTier,
} from "@tarmoto/shared";

const ROAD_QUALITY_MAX_ZOOM = "road_quality_max_zoom";

// The public `/config/limits` map, cached at module scope so a MapScreen
// remount (tab switch) serves the last-known value instantly while a fresh
// fetch revalidates in the background — offline-first, no spinner. `null` until
// the first successful fetch.
let cachedGlobalLimits: GlobalLimitOverrides | null = null;

/** Test-only reset for the module-level global-limits cache. */
export function __resetGlobalLimitsCacheForTest(): void {
  cachedGlobalLimits = null;
}

/**
 * The operator's global override for `road_quality_max_zoom` from the PUBLIC
 * `/config/limits` map (no auth — resolves for signed-out riders). `override`:
 * `undefined` = key ABSENT (no override → resolve normally); `null` = explicit
 * unlimited; a number = an explicit cap. `isResolved` is true once a fetch has
 * succeeded (serving the module cache across remounts). Best-effort: a failed /
 * pending fetch with no cache stays unresolved so callers fail closed.
 */
function useGlobalQualityZoomOverride(enabled: boolean): {
  override: number | null | undefined;
  isResolved: boolean;
} {
  const [map, setMap] = useState<GlobalLimitOverrides | null>(
    cachedGlobalLimits,
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const revalidate = () => {
      // Serve the cache immediately (set above); revalidate so an operator
      // activating/tightening the cap lands without a reload. A failure keeps
      // the last-known cache (or stays unresolved if none), never widening the
      // cap on an outage.
      void api
        .getConfigLimits()
        .then((next) => {
          cachedGlobalLimits = next;
          if (!cancelled) setMap(next);
        })
        .catch(() => {
          // Fail closed / retain last-known — the next revalidate retries.
        });
    };
    // On mount AND on every foreground: React Navigation keeps the Map tab
    // mounted across background/foreground and the root entitlement monitor
    // skips anonymous sessions, so without this an operator removing the
    // launch override would never reach a long-lived anonymous map.
    revalidate();
    const onChange = (next: AppStateStatus) => {
      if (next === "active") revalidate();
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [enabled]);

  if (!map) return { override: undefined, isResolved: false };
  const override = Object.hasOwn(map, ROAD_QUALITY_MAX_ZOOM)
    ? (map[ROAD_QUALITY_MAX_ZOOM] ?? null)
    : undefined;
  return { override, isResolved: true };
}

/**
 * The resolved `road_quality_max_zoom` cap for BOTH authenticated riders and
 * signed-out map users (the map tab + the backend quality tiles are both
 * public, so anonymous riders are real). Authenticated → the `/users/me`
 * snapshot (which already folds in the operator's global override server-side).
 * Confirmed anonymous → resolve from scratch against the PUBLIC `/config/limits`
 * override: the free-tier default replaced by the operator override. That keeps
 * the launch-mode `NULL` seed UNLIMITED (dark) for signed-out riders instead of
 * fail-closing them to the free cap, and post-launch an anonymous rider
 * resolves to the free-tier cap like any free user.
 */
export function useRoadQualityZoomCap(): {
  limit: number | null;
  isResolved: boolean;
} {
  const user = useAuthStore((s) => s.user);
  // Subscribe to settlement REACTIVELY: a MapScreen mounted before a sessionless
  // cold-start bootstrap finishes must re-render when it settles (settlement
  // leaves `user` null, so subscribing to `user` alone would miss it) — only
  // then does the anonymous branch fetch `/config/limits`.
  const bootstrapSettled = useAuthStore((s) => s.bootstrapSettled);
  const authed = user != null;
  // A signed-in rider mid cold-start hydration transiently has `user == null`;
  // resolving the anonymous cap then could render ABOVE their per-user override
  // until `/users/me` lands. Only a SETTLED bootstrap with no user is a
  // confirmed anonymous session.
  const confirmedAnonymous = !authed && bootstrapSettled;

  const { limit: userLimit, isResolved: userResolved } = useLimit(
    ROAD_QUALITY_MAX_ZOOM,
  );
  const { override, isResolved: globalResolved } =
    useGlobalQualityZoomOverride(confirmedAnonymous);

  if (authed) {
    return { limit: userLimit, isResolved: userResolved };
  }
  // Not a confirmed-anonymous session yet (pre-auth hydration) → fail closed.
  if (!confirmedAnonymous || !globalResolved) {
    return { limit: null, isResolved: false };
  }
  // Confirmed anonymous: no tier → registry free/default, then the operator
  // global override replaces it (`undefined` = no override → free default).
  return {
    limit: resolveLimit(ROAD_QUALITY_MAX_ZOOM, null, undefined, override),
    isResolved: true,
  };
}

// The road-tile source's real max zoom: the backend serves real quality MVT
// tiles up to z22 with no internal cap (`RoadTileParamsDto` `@Max(22)` in
// `apps/backend/src/modules/roads/tile-params.dto.ts`), and the
// `<VectorSource maxzoom={22}>` in MapScreen matches that source max. This
// is the LAYER-level ceiling the entitlement cap clamps against, so an
// unlimited (pro/premium, or DARK-launch-seed-resolved) rider's overlay
// renders to z22 unchanged. The free-tier gate (12) is the actual product
// lever, not this ceiling.
const MOBILE_QUALITY_CEILING = 22;

/**
 * The quality `<Layer>`'s `maxzoom` clamped to the rider's resolved
 * `road_quality_max_zoom` entitlement, plus whether the overlay should
 * render at all. A degenerate operator override to 0 clamps `maxzoom` to
 * 0 and `visible` to false (hide entirely) — ordinary finite caps (e.g. 5)
 * still produce a valid `[0, cap)` range since the overlay has no minzoom
 * floor. Callers still gate on the rider's `showQualityOverlay` toggle
 * separately; this hook only reflects the entitlement side.
 */
export function useQualityLayerMaxZoom(): {
  maxzoom: number;
  visible: boolean;
} {
  const { limit, isResolved } = useRoadQualityZoomCap();
  const maxzoom = clampQualityMaxZoom(
    limit,
    isResolved,
    MOBILE_QUALITY_CEILING,
  );
  return { maxzoom, visible: maxzoom > 0 };
}

/**
 * Optional discovery nudge (NOT the enforcement — the clamp above is):
 * one-shot-per-mount `<UpgradePrompt>` trigger when a rider on a FINITE
 * `road_quality_max_zoom` cap pans/zooms past it with the overlay on, and
 * an upgrade would actually lift the cap (a suppressed/override cap or an
 * already-top-tier rider gets no CTA — `upgradeTierForLimit` returns null
 * for both, so no dead-end prompt is shown).
 */
export function shouldShowQualityUpgradePrompt(params: {
  showQualityOverlay: boolean;
  dismissed: boolean;
  /** Raw (unclamped) resolved limit — `null` means unlimited. */
  limit: number | null;
  /** The clamped layer `maxzoom` the rider just zoomed past. */
  maxzoom: number;
  viewZoom: number;
  tier: SubscriptionTier | null;
}): boolean {
  const { showQualityOverlay, dismissed, limit, maxzoom, viewZoom, tier } =
    params;
  return (
    showQualityOverlay &&
    !dismissed &&
    limit !== null &&
    viewZoom > maxzoom &&
    upgradeTierForLimit("road_quality_max_zoom", tier ?? "free", limit) !== null
  );
}
