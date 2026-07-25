/** Free-tier `road_quality_max_zoom` cap — also the fail-closed CEILING while
 *  entitlements are unresolved (a stricter known finite cap still wins). */
export const QUALITY_OVERLAY_FREE_CAP_ZOOM = 12;

/**
 * The overlay LAYER's exclusive `maxzoom` for a resolved `road_quality_max_zoom`
 * limit. The limit feeds maxzoom DIRECTLY (the overlay stops past the cap — no
 * `+1`): finite `N` → `N`; `null` (unlimited) → the platform `sourceCeiling`.
 * Both are clamped to the ceiling (beyond it the vector source over-zooms).
 * Unresolved → fail closed to the free cap, but never WIDEN a stricter finite
 * cap already in hand (e.g. a per-user override mid-refresh). Can only lower.
 */
export function clampQualityMaxZoom(
  limit: number | null,
  isResolved: boolean,
  sourceCeiling: number,
): number {
  if (!isResolved) {
    return limit === null
      ? QUALITY_OVERLAY_FREE_CAP_ZOOM
      : Math.min(limit, QUALITY_OVERLAY_FREE_CAP_ZOOM);
  }
  return limit === null ? sourceCeiling : Math.min(limit, sourceCeiling);
}
