/** The road-quality overlay never renders above this zoom (the vector source's
 *  over-zoom ceiling, mirroring MapCanvas's source maxzoom). */
export const QUALITY_OVERLAY_CEILING_ZOOM = 18;
/** Fail-closed cap while entitlements are unresolved (the free-tier default for
 *  `road_quality_max_zoom`). */
export const QUALITY_OVERLAY_FLOOR_ZOOM = 12;

/**
 * The maxzoom to apply to the road-quality overlay layer, from a resolved
 * `road_quality_max_zoom` limit. `null` = unlimited (pro/premium) → the source
 * ceiling. Until the cap RESOLVES (`isResolved` false — loading / error /
 * pre-auth) fail closed to the free floor rather than render full detail we
 * can't confirm entitlement for.
 */
export function resolveQualityMaxZoom(
  limit: number | null,
  isResolved: boolean,
): number {
  if (!isResolved) return QUALITY_OVERLAY_FLOOR_ZOOM;
  return limit === null ? QUALITY_OVERLAY_CEILING_ZOOM : limit;
}

/**
 * One-shot "zoom past the free cap" discovery-nudge decision for the explore
 * map's quality overlay. The clamp (`resolveQualityMaxZoom` + `MapCanvas`
 * maxzoom) already stops the overlay rendering past the cap on every
 * surface; this predicate only decides whether THIS surface should ALSO pop
 * an upgrade modal — so it must fail closed the same way: `capFinite` false
 * (unresolved OR pro/premium unlimited) never nags, and a prior dismissal
 * this session suppresses further prompts even on continued zooming.
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
