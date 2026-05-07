"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import { fetchFunZonesInBbox, type FunZoneListItem } from "@/lib/discover";
import {
  installFunZoneLayer,
  updateFunZoneLayerData,
  setFunZoneSelection,
  FUN_ZONES_FILL,
  FUN_ZONES_SOURCE,
} from "./FunZoneLayer";
import {
  createRegionDrawControl,
  type RegionDrawControl,
  type RegionDrawMode,
} from "@/components/map/RegionDrawControl";
import { useDiscoverStore } from "./useDiscoverStore";
import { Square, X } from "lucide-react";
const FETCH_DEBOUNCE_MS = 300;
interface Props {
  onZonesLoaded?: (zones: FunZoneListItem[]) => void;
  onZonesError?: (message: string) => void;
  onZonesLoading?: (loading: boolean) => void;
  /** Bumping this integer re-runs the zones fetch without remounting the map. */
  retryNonce?: number;
}
export function DiscoverMap({
  onZonesLoaded,
  onZonesError,
  onZonesLoading,
  retryNonce = 0,
}: Props) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const drawRef = useRef<RegionDrawControl | null>(null);
  const [ready, setReady] = useState(false);
  const [drawMode, setDrawMode] = useState<RegionDrawMode>("idle");
  const prevRequestKeyRef = useRef<string | null>(null);
  // Bumps every time the fun-zones source data changes so the zone-fit
  // effect can retry after a deep-linked `?zone=<id>` when the data
  // wasn't loaded yet on the first pass.
  const [sourceVersion, setSourceVersion] = useState(0);
  // Callback refs so the fetch effect can depend only on stable values.
  // Otherwise parent re-renders pass fresh inline callbacks and re-fire
  // the effect on every render.
  const onZonesLoadedRef = useRef(onZonesLoaded);
  const onZonesErrorRef = useRef(onZonesError);
  const onZonesLoadingRef = useRef(onZonesLoading);
  useEffect(() => {
    onZonesLoadedRef.current = onZonesLoaded;
  }, [onZonesLoaded]);
  useEffect(() => {
    onZonesErrorRef.current = onZonesError;
  }, [onZonesError]);
  useEffect(() => {
    onZonesLoadingRef.current = onZonesLoading;
  }, [onZonesLoading]);
  const {
    center,
    zoom,
    drawnBbox,
    viewportBbox,
    selectedZoneId,
    setCenter,
    setZoom,
    setViewportBbox,
    setDrawnBbox,
    clearDrawnBbox,
    setSelectedZoneId,
  } = useDiscoverStore();
  const effectiveBbox = drawnBbox ?? viewportBbox;
  // ── on map ready, install zone layer + draw control + click handlers ──
  const handleReady = (map: MapLibreMap) => {
    installFunZoneLayer(map);
    drawRef.current = createRegionDrawControl(map, {
      onRegionDrawn: (bbox) => setDrawnBbox(bbox),
      onRegionCleared: () => clearDrawnBbox(),
      onModeChange: setDrawMode,
    });
    // Skip fun-zone hover styling and selection during draw/edit so
    // the region tool's resize/move cursors and click semantics are
    // not clobbered by an underlying zone the rectangle overlaps.
    const pointerOn = () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "pointer";
    };
    const pointerOff = () => {
      if (drawRef.current?.getMode() !== "idle") return;
      map.getCanvas().style.cursor = "";
    };
    map.on("mouseenter", FUN_ZONES_FILL, pointerOn);
    map.on("mouseleave", FUN_ZONES_FILL, pointerOff);
    map.on("click", FUN_ZONES_FILL, (e: MapLayerMouseEvent) => {
      if (drawRef.current?.getMode() !== "idle") return;
      if (drawRef.current?.hitTest(e.point)) return;
      const feature = e.features?.[0];
      const id = feature?.properties?.id as string | undefined;
      if (!id) return;
      setSelectedZoneId(id);
    });
    // Click on bare map (no zone) → clear selection, unless user is
    // drawing or editing the bbox region.
    map.on("click", (e) => {
      if (drawRef.current?.getMode() !== "idle") return;
      if (drawRef.current?.hitTest(e.point)) return;
      const features = map.queryRenderedFeatures(e.point, {
        layers: [FUN_ZONES_FILL],
      });
      if (features.length === 0) setSelectedZoneId(null);
    });
    setReady(true);
  };
  const handleViewChange = (view: {
    lng: number;
    lat: number;
    zoom: number;
    bbox: [number, number, number, number];
  }) => {
    setCenter({ lng: view.lng, lat: view.lat });
    setZoom(view.zoom);
    setViewportBbox(view.bbox);
  };
  // Debounced fetch of zones whenever the effective bbox changes (or the
  // caller bumps retryNonce). The dedupe key combines bbox + nonce so
  // identical requests (unchanged bbox, same nonce) are skipped while a
  // retry bump forces a refetch exactly once.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready || !effectiveBbox) return;
    const bboxKey = effectiveBbox.map((n) => n.toFixed(5)).join(",");
    const requestKey = `${bboxKey}:${retryNonce}`;
    if (requestKey === prevRequestKeyRef.current) return;
    prevRequestKeyRef.current = requestKey;
    const controller = new AbortController();
    let cancelled = false;
    onZonesLoadingRef.current?.(true);
    const timer = window.setTimeout(async () => {
      try {
        const zones = await fetchFunZonesInBbox(effectiveBbox, {
          signal: controller.signal,
        });
        if (cancelled) return;
        zones.sort((a, b) => b.composite_score - a.composite_score);
        updateFunZoneLayerData(map, zones);
        setSourceVersion((v) => v + 1);
        onZonesLoadedRef.current?.(zones);
      } catch (err) {
        if (
          (
            err as {
              name?: string;
            }
          ).name === "AbortError"
        )
          return;
        console.warn("[discover] zones fetch failed", err);
        onZonesErrorRef.current?.("Couldn't load zones.");
      } finally {
        if (!cancelled) onZonesLoadingRef.current?.(false);
      }
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ready, effectiveBbox, retryNonce]);
  // Keep the drawn-rectangle overlay in sync with URL-hydrated state.
  useEffect(() => {
    if (!ready) return;
    drawRef.current?.setDrawn(drawnBbox);
  }, [ready, drawnBbox]);
  // Keep the selection outline in sync with state and pan/zoom to the zone.
  // `sourceVersion` is a dep so deep-linked `?zone=<id>` URLs get fitted
  // once the zones source is populated, not just on selection changes.
  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    setFunZoneSelection(map, selectedZoneId);
    if (!selectedZoneId) return;
    // Look up the selected zone's boundary by querying the source. This avoids
    // plumbing the zones list down into DiscoverMap. `querySourceFeatures`
    // returns rendered + unrendered features from the source.
    const matches = map.querySourceFeatures(FUN_ZONES_SOURCE, {
      filter: ["==", ["get", "id"], selectedZoneId],
    });
    const geom = matches[0]?.geometry;
    if (!geom || geom.type !== "Polygon") return;
    const ring = geom.coordinates[0];
    if (!ring || ring.length === 0) return;
    let minLng = Infinity,
      maxLng = -Infinity,
      minLat = Infinity,
      maxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    try {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 60, duration: 500, maxZoom: 13 },
      );
    } catch (err) {
      // Malformed boundary — log and move on rather than blow up the UI.
      console.warn("[discover] fitBounds failed", err);
    }
  }, [ready, selectedZoneId, sourceVersion]);
  // Esc clears the selection so the user can dismiss the detail panel
  // without reaching for the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedZoneId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelectedZoneId]);
  // Cleanup: the draw control installs its own sources/layers, remove them
  // on unmount. MapCanvas will remove the map itself.
  useEffect(() => {
    return () => {
      drawRef.current?.destroy();
      drawRef.current = null;
    };
  }, []);
  return (
    <MapCanvas
      ref={handleRef}
      center={center}
      zoom={zoom}
      showQuality={true}
      showSurface={false}
      onReady={handleReady}
      onViewChange={handleViewChange}
    >
      {/* Draw controls overlay (absolute-positioned inside MapCanvas's wrapper) */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        {drawMode === "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.cancel()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-tarmoto-cyan/20 border border-tarmoto-cyan text-tarmoto-cyan text-sm hover:bg-tarmoto-cyan/30 transition"
          >
            <X size={14} />
            {t("Cancel drawing ")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => drawRef.current?.start()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900/90 border border-slate-700 text-slate-100 text-sm hover:bg-slate-800 transition"
          >
            <Square size={14} />
            {drawnBbox ? t("Redraw region ") : t("Draw region ")}
          </button>
        )}
        {drawnBbox && drawMode !== "drawing" ? (
          <button
            type="button"
            onClick={() => drawRef.current?.clearDrawn()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900/90 border border-slate-700 text-slate-300 text-sm hover:bg-slate-800 transition"
          >
            <X size={12} />
            {t("Clear region ")}
          </button>
        ) : null}
      </div>
    </MapCanvas>
  );
}
