import React from "react";
import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
import { useTileCredentialKey } from "@/hooks/useTileCredentialKey";
import type { LineLayerConfig } from "./MapScreen.helpers";

/**
 * Road-quality vector overlay. Kept in its own module (not inline in the screen
 * body) so the entitlement clamp — the sole client-side monetization boundary —
 * is unit-testable at the JSX level without dragging in the whole MapScreen:
 * the LAYER's `maxzoom` (`= maxzoom`, the resolved cap) and the `visible` gate
 * that removes the source on a degenerate cap. TypeScript also forces the screen
 * to pass both props.
 *
 * The VectorSource's own `maxzoom={22}` is a loose over-zoom setting left
 * untouched; the entitlement cap clamps the LAYER instead. `visible` is false
 * only on a degenerate operator override (cap clamped at/below the map floor) —
 * then the whole source is dropped so nothing renders.
 */
export function QualityOverlaySource({
  show,
  visible,
  regionKey,
  tileUrl,
  maxzoom,
  style,
}: {
  show: boolean;
  visible: boolean;
  regionKey: string;
  tileUrl: string;
  maxzoom: number;
  style: LineLayerConfig;
}): React.ReactElement | null {
  // Before the early return: hooks must run on every render.
  const credentialKey = useTileCredentialKey();
  if (!show || !visible) return null;
  return (
    // `key` includes the offline region so MapLibre fully remounts the
    // VectorSource when we swap between the backend URL and a cached `file://`
    // template — keeping the same `id` would leave the native side pointing at
    // the old tile URL after React updated the prop.
    //
    // It includes the tile credential's presence for the same reason (#1279):
    // the native URL transform that stamps the credential changes neither the
    // URL template nor MapLibre's tile cache key, so a source that fetched
    // z13+ tiles before the mint landed would keep serving those anonymous,
    // free-capped tiles. Remounting refetches them as this rider.
    <VectorSource
      key={`quality-${regionKey}-${credentialKey}`}
      id="tarmoto-quality"
      tiles={[tileUrl]}
      minzoom={0}
      maxzoom={22}
    >
      <Layer
        type="line"
        id="tarmoto-quality-lines"
        source="tarmoto-quality"
        source-layer="quality"
        maxzoom={maxzoom}
        {...style}
      />
    </VectorSource>
  );
}
