"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";
import type { ExpressionSpecification } from "@/lib/maplibre-expression";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import type { MapColorScheme } from "@/lib/map-style";
import {
  DIM_LINE_COLOR,
  RIDDEN_LINE_COLOR,
  ROAD_MAP_DIM_LAYER_ID,
  ROAD_MAP_LAYER_LINE_WIDTH,
  ROAD_MAP_RIDDEN_LAYER_ID,
  ROAD_MAP_RIDDEN_LINE_WIDTH,
  indexRiddenSegments,
  type RiddenSegment,
} from "@/lib/road-map-layer";
import { QUALITY_CONFIG, scoreToTier } from "@/lib/utils";

const SOURCE_ID = "tarmoto-roads";
const QUALITY_LAYER = "quality";

export interface PersonalRoadMapHandle {
  flyTo: (coords: { lat: number; lng: number; zoom?: number }) => void;
}

interface Props {
  /**
   * Initial center for the map. Updates after mount come from `flyTo()` via
   * the imperative handle so the map doesn't yank the view on every parent
   * re-render.
   */
  initialCenter: { lat: number; lng: number; zoom: number };
  /**
   * Filtered ridden segments (period-aware). The cyan layer paints the
   * features in this list; everything else falls through to the dim base.
   */
  ridden: readonly RiddenSegment[];
  /**
   * Pin the basemap theme instead of following the viewer preference — the
   * public share page always renders on cream.
   */
  forceColorScheme?: MapColorScheme;
  /**
   * Override the unridden (dim) line colour. Defaults to the dashboard's
   * dark-surface slate; the cream share page passes a light tan so unridden
   * roads read against the light basemap.
   */
  dimColor?: string;
}

/**
 * Personal road-map MapLibre overlay (US-50).
 *
 * Mounts the shared MapCanvas (which provides the basemap + the
 * `tarmoto-roads` vector source) but disables its quality/surface layers —
 * the road-map view paints its own dim base + cyan ridden overlay using
 * `feature-state` for O(1) membership at draw time. The hover popup
 * surfaces the most-recent ride date and quality reading for the segment
 * under the cursor.
 */
export const PersonalRoadMap = forwardRef<PersonalRoadMapHandle, Props>(
  function PersonalRoadMap(
    { initialCenter, ridden, forceColorScheme, dimColor },
    ref,
  ) {
    const canvasRef = useRef<MapCanvasHandle>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const [ready, setReady] = useState(false);
    const popupRef = useRef<maplibregl.Popup | null>(null);

    const indexedRidden = useMemo(() => indexRiddenSegments(ridden), [ridden]);
    const indexedRiddenRef = useRef(indexedRidden);
    useEffect(() => {
      indexedRiddenRef.current = indexedRidden;
    }, [indexedRidden]);

    useImperativeHandle(ref, () => ({
      flyTo: ({ lat, lng, zoom }) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({
          center: [lng, lat],
          zoom: zoom ?? Math.max(map.getZoom(), 9),
          essential: true,
        });
      },
    }));

    const handleReady = useCallback(
      (map: MapLibreMap) => {
        mapRef.current = map;

        // Place both layers ABOVE the basemap labels but BELOW the canvas's
        // existing quality/surface layers (which the page renders invisible
        // anyway via showQuality={false} / showSurface={false}). We insert
        // before the canvas's quality layer so the dim base + cyan overlay
        // sit at the same z-position as the rest of the road styling.
        const beforeId = map.getLayer("tarmoto-quality")
          ? "tarmoto-quality"
          : undefined;

        map.addLayer(
          {
            id: ROAD_MAP_DIM_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            "source-layer": QUALITY_LAYER,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": dimColor ?? DIM_LINE_COLOR,
              "line-width":
                ROAD_MAP_LAYER_LINE_WIDTH as unknown as ExpressionSpecification,
              "line-opacity": dimColor ? 0.7 : 0.35,
            },
          },
          beforeId,
        );

        map.addLayer(
          {
            id: ROAD_MAP_RIDDEN_LAYER_ID,
            type: "line",
            source: SOURCE_ID,
            "source-layer": QUALITY_LAYER,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": RIDDEN_LINE_COLOR,
              "line-width":
                ROAD_MAP_RIDDEN_LINE_WIDTH as unknown as ExpressionSpecification,
              // Only paint features whose feature-state.ridden has been set
              // by the `useEffect` below. Anything else stays transparent so
              // the dim base shows through.
              "line-opacity": [
                "case",
                ["boolean", ["feature-state", "ridden"], false],
                0.95,
                0,
              ] as ExpressionSpecification,
            },
          },
          beforeId,
        );

        // Hover/click popups — bind to the cyan layer. The layer paints
        // every quality feature (unridden ones at opacity 0 via
        // feature-state) so MapLibre still hit-tests their geometry; the
        // `meta` lookup below distinguishes ridden hover targets from
        // transparent ones, and dismisses the popup when the cursor is
        // over the latter so it doesn't linger from a previous ridden
        // hover.
        const dismissPopup = () => {
          if (popupRef.current) {
            popupRef.current.remove();
            popupRef.current = null;
          }
          map.getCanvas().style.cursor = "";
        };

        const handlePointerMove = (
          ev: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] },
        ) => {
          const feature = ev.features?.[0];
          if (!feature) {
            dismissPopup();
            return;
          }
          const id = feature.id;
          const meta =
            typeof id === "string" ? indexedRiddenRef.current.get(id) : null;
          if (!meta) {
            // Transparent feature (unridden) under the cursor — clear any
            // popup left over from a ridden segment we just moved off of.
            dismissPopup();
            return;
          }

          const html = renderPopupHtml(meta);
          if (popupRef.current) {
            popupRef.current.setLngLat(ev.lngLat).setHTML(html);
          } else {
            popupRef.current = new maplibregl.Popup({
              closeButton: false,
              closeOnClick: false,
              offset: 10,
            })
              .setLngLat(ev.lngLat)
              .setHTML(html)
              .addTo(map);
          }
          map.getCanvas().style.cursor = "pointer";
        };

        const handlePointerLeave = () => {
          dismissPopup();
        };

        map.on("mousemove", ROAD_MAP_RIDDEN_LAYER_ID, handlePointerMove);
        map.on("mouseleave", ROAD_MAP_RIDDEN_LAYER_ID, handlePointerLeave);

        setReady(true);
        // `dimColor` is read when the dim layer is added on map load; it's a
        // stable prop per mount, but list it so the linter is satisfied.
      },
      [dimColor],
    );

    // Apply `feature-state.ridden = true` for every segment in the current
    // (period-filtered) ridden set. `removeFeatureState` clears the whole
    // source-layer in one call — much cheaper than diffing the previous
    // set, and feature-state is cumulative so re-setting on every change
    // is safe.
    useEffect(() => {
      const map = mapRef.current;
      if (!map || !ready) return;
      map.removeFeatureState({ source: SOURCE_ID, sourceLayer: QUALITY_LAYER });
      for (const seg of ridden) {
        map.setFeatureState(
          { source: SOURCE_ID, sourceLayer: QUALITY_LAYER, id: seg.id },
          { ridden: true },
        );
      }
    }, [ready, ridden]);

    // Tear-down popup on unmount so a stray reference doesn't leak after
    // the map has been removed by MapCanvas's own cleanup.
    useEffect(() => {
      return () => {
        if (popupRef.current) {
          popupRef.current.remove();
          popupRef.current = null;
        }
      };
    }, []);

    return (
      <MapCanvas
        ref={canvasRef}
        center={{ lng: initialCenter.lng, lat: initialCenter.lat }}
        zoom={initialCenter.zoom}
        showQuality={false}
        showSurface={false}
        forceColorScheme={forceColorScheme}
        onReady={handleReady}
      />
    );
  },
);

function renderPopupHtml(seg: RiddenSegment): string {
  const date = new Date(seg.last_ridden_at);
  const dateLabel = Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

  const tier =
    seg.last_quality_score != null ? scoreToTier(seg.last_quality_score) : null;
  const tierInfo = tier ? QUALITY_CONFIG[tier] : null;

  const qualityRow = tierInfo
    ? `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
         <span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${tierInfo.hex};"></span>
         <span>${escapeHtml(tierInfo.label)} · ${seg.last_quality_score?.toFixed(1)}</span>
       </div>`
    : `<div style="margin-top:4px;color:#94a3b8;">No quality reading</div>`;

  const rides = seg.ride_count;
  const ridesLabel = `${rides} ride${rides === 1 ? "" : "s"}`;

  return `
    <div style="font: 12px/1.4 system-ui, sans-serif; color:#e2e8f0; min-width:160px;">
      <div style="font-weight:600;color:white;">Last ridden ${escapeHtml(dateLabel)}</div>
      ${qualityRow}
      <div style="margin-top:4px;color:#94a3b8;">${ridesLabel}</div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
