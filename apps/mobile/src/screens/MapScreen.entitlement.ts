/**
 * Entitlement-driven decisions for `MapScreen`'s road-quality overlay.
 * Extracted so the clamp + visibility logic is unit-testable without
 * rendering the full screen (native MapLibre modules, sockets, stores).
 */
import { useLimit } from "@/hooks/useEntitlements";
import {
  clampQualityMaxZoom,
  upgradeTierForLimit,
  type SubscriptionTier,
} from "@tarmoto/shared";

// The road-tile source's real max zoom. The `<VectorSource maxzoom={22}>`
// in MapScreen is a loose over-zoom setting on the tile source itself —
// this is the LAYER-level ceiling the entitlement cap clamps against.
const MOBILE_QUALITY_CEILING = 18;

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
  const { limit, isResolved } = useLimit("road_quality_max_zoom");
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
