import {
  clampQualityMaxZoom,
  QUALITY_OVERLAY_FREE_CAP_ZOOM,
} from "@tarmoto/shared";

/** Free-tier `road_quality_max_zoom` cap. Per the rollout spec the limit feeds
 *  the overlay layer's `maxzoom` DIRECTLY, so the overlay stops past the cap —
 *  free riders see quality up to zoom 12. Also the fail-closed ceiling while
 *  entitlements are unresolved (a stricter known cap still wins). */
export { QUALITY_OVERLAY_FREE_CAP_ZOOM };
/** The vector source's static max zoom — the pre-entitlement overlay ceiling
 *  and the maxzoom an UNLIMITED (pro/premium, `null`) rider gets. Also the upper
 *  clamp for any finite operator override (beyond it the source over-zooms, so
 *  a higher maxzoom would show no extra data). */
export const QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM = 18;

/**
 * The MapLibre layer `maxzoom` for the quality-graded layers, from a resolved
 * `road_quality_max_zoom` limit. Per the rollout spec the limit feeds `maxzoom`
 * DIRECTLY (MapLibre stops drawing the overlay past the layer maxzoom, so the
 * overlay stops AT the cap — no `+1`):
 *  - finite cap `N` (e.g. free 12) → `N`, clamped to the source ceiling (18),
 *  - `null` (pro/premium unlimited) → the source ceiling (18),
 *  - unresolved (loading / error / pre-auth) → fail closed WITHOUT widening a
 *    stricter cap we already know: clamp any finite limit already in hand (e.g.
 *    `/users/me` resolved but `/config/limits` is failing, or a signed-in rider
 *    mid-hydration) to the stricter of it and the free cap; a still-unknown
 *    (`null`) limit falls back to the free cap — never unlimited — for the
 *    outage. This can only lower, never raise, the visible ceiling.
 *
 * Delegates to the shared `clampQualityMaxZoom` (parameterized ceiling) so
 * mobile can reuse the same math against its own platform ceiling.
 */
export function resolveQualityLayerMaxZoom(
  limit: number | null,
  isResolved: boolean,
): number {
  return clampQualityMaxZoom(
    limit,
    isResolved,
    QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM,
  );
}

/**
 * One-shot "zoom past the free cap" discovery-nudge decision for the explore
 * map's quality overlay. The clamp (`resolveQualityLayerMaxZoom` + `MapCanvas`
 * maxzoom) already stops the overlay rendering past the cap on every surface;
 * this predicate only decides whether THIS surface should ALSO pop an upgrade
 * modal — so it must fail closed the same way: `capFinite` false (unresolved OR
 * pro/premium unlimited) never nags, and a prior dismissal this session
 * suppresses further prompts even on continued zooming. `cap` is the raw
 * entitlement cap LEVEL (e.g. free 12); the modal fires once the rider zooms
 * past it.
 */
export function shouldPromptQualityZoom({
  showQuality,
  capFinite,
  zoom,
  cap,
  dismissed,
}: {
  showQuality: boolean;
  capFinite: boolean;
  zoom: number;
  cap: number;
  dismissed: boolean;
}): boolean {
  return showQuality && capFinite && zoom > cap && !dismissed;
}

/**
 * Whether Explore may SELECT a road (opening the detail drawer) via a given
 * overlay at the current zoom. The road/surface hit layers are uncapped (so
 * planner snapping still works past the cap), but the Explore detail drawer is
 * road-QUALITY intelligence — exact score, provenance, history — so a selection
 * through EITHER the quality or the surface overlay reveals the gated data.
 * Allow it only while the quality overlay would render: below the resolved
 * exclusive maxzoom (`qualityMaxZoom` from `resolveQualityLayerMaxZoom`, which
 * already folds in the cap, the free fail-closed floor, and the at/below-floor
 * case). `overlayEnabled` is that overlay's own toggle.
 */
export function canSelectRoadAtZoom(
  overlayEnabled: boolean,
  zoom: number,
  qualityMaxZoom: number,
): boolean {
  return overlayEnabled && zoom < qualityMaxZoom;
}
