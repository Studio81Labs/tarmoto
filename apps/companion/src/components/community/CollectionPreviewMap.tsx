"use client";

import { useTranslation } from "@/i18n/I18nProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin } from "lucide-react";
import { MAP_STYLE_URL } from "@/lib/config";
import { applyTarmotoMapTheme } from "@/lib/map-style";
import type { SanitizedCollectionPreviewItem } from "@/lib/route-collection-share";
interface Props {
  /**
   * The preview routes from the SSR fetch (geometry + per-item summaries).
   * Passed in rather than re-fetched client-side so the rows and the map share
   * one payload.
   */
  routes: SanitizedCollectionPreviewItem[];
}
const SOURCE_ID = "collection-preview";
const ROUTE_LAYER_ID = "collection-preview-routes";
const DEFAULT_CENTER: [number, number] = [14.4378, 50.0755]; // Prague — same fallback as RidesMap.
// Brand orange — the design traces every route in one accent colour rather
// than the dashboard's trip/ride split, since a public viewer reads the map as
// a single "here's the collection" shape.
const ROUTE_COLOR = "#FF6A1A";
/**
 * Public collection page map preview (#358). Mounts MapLibre client-side (the
 * SSR'd page only needs the metadata) and renders the simplified geometries
 * handed down from the page's preview fetch. Forces the light map theme to
 * match the cream share page.
 *
 * Performance notes (issue acceptance criterion is 20+ items):
 *  - Geometries are simplified server-side (~50 m tolerance) so a 20-item
 *    collection ships ~tens of KB of polyline data, not megabytes.
 *  - One GeoJSON source, one line layer → one upload to GL, one bbox calc.
 *  - Bounds auto-fit once; later user interactions aren't clobbered.
 */
export function CollectionPreviewMap({ routes }: Props) {
  const t = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const fittedOnceRef = useRef(false);
  const drawableCount = useMemo(
    () => routes.filter((r) => r.lines.some((l) => l.length >= 2)).length,
    [routes],
  );
  const hasGeometry = drawableCount > 0;
  // ── init map once we have drawable data ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !hasGeometry) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 4,
      attributionControl: { compact: true },
      cooperativeGestures: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.on("load", () => {
      applyTarmotoMapTheme(map, "light");
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: ROUTE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROUTE_COLOR,
          "line-width": 3,
          "line-opacity": 0.9,
        },
      });
      setReady(true);
    });
    mapRef.current = map;
    // The parent's responsive layout can change the container size; MapLibre
    // needs an explicit `.resize()` or it renders blank/clipped on hydrate.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
      fittedOnceRef.current = false;
    };
  }, [hasGeometry]);
  // ── push features → source + auto-fit ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource(SOURCE_ID) as
      maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    for (const route of routes) {
      for (const line of route.lines) {
        if (line.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { item_id: route.item_id },
          geometry: { type: "LineString", coordinates: line },
        });
      }
    }
    src.setData({ type: "FeatureCollection", features });
    if (!fittedOnceRef.current && features.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const f of features) {
        const coords = (f.geometry as GeoJSON.LineString).coordinates;
        for (const c of coords) {
          const lng = c[0];
          const lat = c[1];
          if (lng !== undefined && lat !== undefined) bounds.extend([lng, lat]);
        }
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds as LngLatBoundsLike, {
          padding: 40,
          duration: 0,
          // Cap zoom so single-day rides don't snap past street level — the
          // preview should always read as "a region", not a building.
          maxZoom: 13,
        });
      }
      fittedOnceRef.current = true;
    }
  }, [ready, routes]);
  if (!hasGeometry) {
    return (
      <div className="flex h-48 flex-col items-center justify-center rounded-[14px] border border-line bg-cream px-6 text-center text-sm text-fg-dim">
        <MapPin size={24} className="mb-2 text-fg-mute" aria-hidden="true" />
        {routes.length === 0
          ? t("No routes to preview yet.")
          : t("These routes don't have map data attached.")}
      </div>
    );
  }
  return (
    <div className="relative h-[380px] w-full overflow-hidden rounded-[14px] border border-line">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute bottom-4 left-4 inline-flex items-center gap-2.5 rounded-[10px] border border-line-strong bg-cream px-3.5 py-2.5 text-[12px] font-semibold text-ink shadow-[0_6px_16px_rgba(14,14,16,0.08)]">
        <span
          aria-hidden="true"
          className="inline-block h-1 w-5 rounded-sm"
          style={{ backgroundColor: ROUTE_COLOR }}
        />
        {t("{count, plural, one {# route traced} other {# routes traced}}", {
          count: drawableCount,
        })}
      </div>
    </div>
  );
}
