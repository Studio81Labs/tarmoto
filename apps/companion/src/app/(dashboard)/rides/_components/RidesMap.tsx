"use client";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type LngLatBoundsLike,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MAP_STYLE_URL } from "@/lib/config";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import type { RideTrack } from "./useRidesQuery";
interface Props {
  tracks: RideTrack[];
  truncated: boolean;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}
const SOURCE_ID = "rides-tracks";
const LAYER_ID = "rides-tracks-line";
const DEFAULT_CENTER: [number, number] = [14.4378, 50.0755]; // Prague
export function RidesMap({
  tracks,
  truncated,
  loading,
  selectedId,
  onSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // `ready` is state, not a ref, so the tracks/selection effects re-run once
  // the map's `load` event lands — otherwise a payload that arrives before
  // the style finishes loading would be silently dropped.
  const [ready, setReady] = useState(false);
  const hoverRef = useRef<string | null>(null);
  const fittedOnceRef = useRef(false);
  const colorScheme = useMapColorScheme();
  const colorSchemeRef = useRef(colorScheme);
  const appliedColorSchemeRef = useRef<MapColorScheme | null>(null);
  useEffect(() => {
    colorSchemeRef.current = colorScheme;
  }, [colorScheme]);
  // Keep the latest onSelect in a ref so the click handler registered in
  // the init-once effect always calls the current callback, even if the
  // parent passes a new closure.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // ── init map once ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 6,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.on("load", () => {
      applyTarmotoMapTheme(map, colorSchemeRef.current);
      appliedColorSchemeRef.current = colorSchemeRef.current;
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#22d3ee", // cyan-400
            ["boolean", ["feature-state", "hover"], false],
            "#22d3ee",
            "#64748b", // slate-500
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            4,
            ["boolean", ["feature-state", "hover"], false],
            3,
            2,
          ],
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            ["boolean", ["feature-state", "hover"], false],
            0.9,
            0.6,
          ],
        },
      });
      map.on("click", LAYER_ID, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f?.properties?.id) return;
        onSelectRef.current(String(f.properties.id));
      });
      map.on("mouseenter", LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mousemove", LAYER_ID, (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (!id) return;
        if (hoverRef.current && hoverRef.current !== id) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoverRef.current },
            { hover: false },
          );
        }
        hoverRef.current = id;
        map.setFeatureState({ source: SOURCE_ID, id }, { hover: true });
      });
      map.on("mouseleave", LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
        if (hoverRef.current) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoverRef.current },
            { hover: false },
          );
          hoverRef.current = null;
        }
      });
      setReady(true);
    });
    mapRef.current = map;
    // When the container shows/resizes (mobile tab switch, desktop layout
    // change), MapLibre needs an explicit resize — otherwise it keeps the
    // size it measured at init and renders blank or clipped.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      appliedColorSchemeRef.current = null;
      setReady(false);
      fittedOnceRef.current = false;
    };
  }, []);
  // ── push tracks → source ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;
    const features = tracks
      .filter((t) => t.geometry)
      .map((t) => ({
        type: "Feature" as const,
        id: t.id,
        properties: { id: t.id },
        geometry: t.geometry!,
      }));
    src.setData({ type: "FeatureCollection", features });
    // Fit to bounds once on first non-empty payload, then preserve the user's
    // view on subsequent filter changes.
    if (!fittedOnceRef.current && features.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const f of features) {
        for (const c of f.geometry.coordinates) {
          bounds.extend([c[0], c[1]]);
        }
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds as LngLatBoundsLike, {
          padding: 40,
          duration: 0,
        });
      }
      fittedOnceRef.current = true;
    }
  }, [ready, tracks]);
  // ── reflect selection via feature-state + fly-to ──
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const prev = selectedRef.current;
    if (prev && prev !== selectedId) {
      map.setFeatureState({ source: SOURCE_ID, id: prev }, { selected: false });
    }
    if (selectedId) {
      map.setFeatureState(
        { source: SOURCE_ID, id: selectedId },
        { selected: true },
      );
      const t = tracks.find((x) => x.id === selectedId);
      if (t?.geometry?.coordinates.length) {
        const bounds = new maplibregl.LngLatBounds();
        for (const c of t.geometry.coordinates) {
          bounds.extend([c[0], c[1]]);
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds as LngLatBoundsLike, {
            padding: 60,
            maxZoom: 14,
            duration: 600,
          });
        }
      }
    }
    selectedRef.current = selectedId;
  }, [ready, selectedId, tracks]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || appliedColorSchemeRef.current === colorScheme) return;
    applyTarmotoMapTheme(map, colorScheme);
    appliedColorSchemeRef.current = colorScheme;
  }, [colorScheme, ready]);
  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-slate-800">
      <div ref={containerRef} className="absolute inset-0" />
      {loading && (
        <div className="absolute top-2 right-2 rounded-full bg-slate-900/80 border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
          {t("Loading\u2026 ")}
        </div>
      )}
      {truncated && (
        <div className="absolute bottom-2 left-2 rounded-lg bg-slate-900/90 border border-amber-600/50 px-3 py-1.5 text-xs text-amber-200 max-w-[320px]">
          {t(
            "Showing most recent 500 rides \u2014 refine filters to narrow the map. ",
          )}
        </div>
      )}
    </div>
  );
}
