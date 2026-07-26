import React from "react";
import { Layer, VectorSource } from "@maplibre/maplibre-react-native";
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
  if (!show || !visible) return null;
  return (
    // `key` includes the offline region so MapLibre fully remounts the
    // VectorSource when we swap between the backend URL and a cached `file://`
    // template — keeping the same `id` would leave the native side pointing at
    // the old tile URL after React updated the prop.
    <VectorSource
      key={`quality-${regionKey}`}
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
