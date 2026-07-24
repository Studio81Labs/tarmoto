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
