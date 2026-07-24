/** Free-tier `road_quality_max_zoom` cap — the max zoom LEVEL a free rider is
 *  entitled to see the quality overlay at (inclusive). Also the fail-closed cap
 *  while entitlements are unresolved. */
export const QUALITY_OVERLAY_FREE_CAP_ZOOM = 12;
/** MapLibre's practical zoom ceiling. An unlimited (pro/premium) rider's quality
 *  layers render up to here so the overlay is never hidden by the entitlement
 *  clamp (the vector source's own over-zoom handles tiles past its maxzoom). */
export const QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM = 24;

/**
 * The EXCLUSIVE MapLibre layer `maxzoom` for the quality-graded layers, from a
 * resolved `road_quality_max_zoom` limit. MapLibre hides a layer at
 * `zoom >= maxzoom`, so to keep the entitled level fully visible the layer
 * maxzoom is ONE level above the entitlement cap:
 *  - finite cap `N` (e.g. free 12) → `N + 1` (level N renders, N+1 does not),
 *  - `null` (pro/premium unlimited) → the render ceiling (never hidden),
 *  - unresolved (loading / error / pre-auth) → fail closed to the free cap + 1.
 */
export function resolveQualityLayerMaxZoom(
  limit: number | null,
  isResolved: boolean,
): number {
  if (!isResolved) return QUALITY_OVERLAY_FREE_CAP_ZOOM + 1;
  if (limit === null) return QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM;
  // `limit + 1` for the exclusive bound, but MapLibre `maxzoom` only accepts
  // [0, 24] — an operator can set the cap to 24+ (the admin limit DTO allows
  // it), so clamp to the ceiling rather than emit an invalid value that fails
  // the map load.
  return Math.min(limit + 1, QUALITY_OVERLAY_UNLIMITED_MAX_ZOOM);
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
