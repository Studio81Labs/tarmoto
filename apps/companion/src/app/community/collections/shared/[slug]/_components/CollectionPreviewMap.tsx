"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Loader2, MapPin } from "lucide-react";
import { MAP_STYLE_URL } from "@/lib/config";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import {
  routeCollectionsApi,
  type RouteCollectionPreviewItem,
} from "@/lib/api";

interface Props {
  slug: string;
  /**
   * `item_count` from the parent detail fetch — drives the empty/loading
   * states. When zero we render a friendly empty card instead of mounting
   * MapLibre at all (no point spinning up GL for a collection with nothing
   * to draw).
   */
  itemCount: number;
}

const SOURCE_ID = "collection-preview";
const TRIP_LAYER_ID = "collection-preview-trips";
const RIDE_LAYER_ID = "collection-preview-rides";
const DEFAULT_CENTER: [number, number] = [14.4378, 50.0755]; // Prague — same fallback as RidesMap.

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; routes: RouteCollectionPreviewItem[] }
  | { phase: "error"; message: string };

/**
 * Public collection page map preview (#358). Mounts MapLibre client-side
 * (the SSR'd page only needs the metadata) and pulls simplified geometries
 * from `/collections/by-slug/:slug/preview`. The endpoint mirrors the
 * detail endpoint's visibility gating, so a collection that 404s on the
 * detail fetch will 404 here too — that's OK because the parent page
 * already calls `notFound()` before we mount.
 *
 * Performance notes (issue acceptance criterion is 20+ items):
 *  - Geometries are simplified server-side (~50 m tolerance) so a 20-item
 *    collection ships ~tens of KB of polyline data, not megabytes.
 *  - Trips and rides go into the same GeoJSON source with a `kind` property
 *    and are styled by two layers on a `["==", ["get","kind"], …]` filter.
 *    One source means one upload to GL and one bbox calculation.
 *  - Bounds are auto-fit once on the first non-empty payload; the user's
 *    interactions afterwards aren't clobbered.
 */
export function CollectionPreviewMap({ slug, itemCount }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const fittedOnceRef = useRef(false);
  const colorScheme = useMapColorScheme();
  const colorSchemeRef = useRef(colorScheme);
  const appliedColorSchemeRef = useRef<MapColorScheme | null>(null);

  useEffect(() => {
    colorSchemeRef.current = colorScheme;
  }, [colorScheme]);

  const [load, setLoad] = useState<LoadState>({ phase: "loading" });

  // ── fetch the preview payload ──
  useEffect(() => {
    if (itemCount === 0) {
      setLoad({ phase: "ready", routes: [] });
      return;
    }
    let cancelled = false;
    setLoad({ phase: "loading" });
    void (async () => {
      try {
        const { data } = await routeCollectionsApi.getPreviewBySlug(slug);
        if (cancelled) return;
        setLoad({ phase: "ready", routes: data.routes });
      } catch (err) {
        if (cancelled) return;
        setLoad({
          phase: "error",
          message:
            err instanceof Error ? err.message : "Failed to load preview",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, itemCount]);

  // ── init map once we have non-empty data ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (load.phase !== "ready" || load.routes.length === 0) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 4,
      attributionControl: { compact: true },
      // Public preview — no edits, no panning beyond what's relevant.
      // Keep nav controls minimal so the map reads as a "preview".
      cooperativeGestures: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

    map.on("load", () => {
      applyTarmotoMapTheme(map, colorSchemeRef.current);
      appliedColorSchemeRef.current = colorSchemeRef.current;

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Trips render in cyan (the brand color) and rides in emerald — same
      // visual language the dashboard uses to distinguish planner trips
      // from recorded rides, so a viewer who has seen the owner's library
      // before recognises the convention immediately.
      map.addLayer({
        id: TRIP_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "trip"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#22d3ee",
          "line-width": 3,
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: RIDE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "ride"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#34d399",
          "line-width": 3,
          "line-opacity": 0.85,
        },
      });

      setReady(true);
    });

    mapRef.current = map;

    // Resize observer — the parent's responsive layout can change the
    // map container size, and MapLibre needs an explicit `.resize()` to
    // pick up the new viewport. Without this, the map renders blank or
    // clipped on first paint when the page hydrates.
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
  }, [load]);

  // ── push features → source + auto-fit ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || load.phase !== "ready") return;
    const src = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;

    const features: GeoJSON.Feature[] = [];
    for (const route of load.routes) {
      for (const line of route.lines) {
        if (line.length < 2) continue;
        features.push({
          type: "Feature",
          properties: { item_id: route.item_id, kind: route.kind },
          geometry: { type: "LineString", coordinates: line },
        });
      }
    }
    src.setData({ type: "FeatureCollection", features });

    if (!fittedOnceRef.current && features.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const f of features) {
        const coords = (f.geometry as GeoJSON.LineString).coordinates;
        for (const c of coords) bounds.extend([c[0], c[1]]);
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds as LngLatBoundsLike, {
          padding: 32,
          duration: 0,
          // Cap zoom so single-day rides don't snap in past street level —
          // the preview should always read as "a region", not a building.
          maxZoom: 13,
        });
      }
      fittedOnceRef.current = true;
    }
  }, [ready, load]);

  // ── re-apply theme on color-scheme changes ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || appliedColorSchemeRef.current === colorScheme) return;
    applyTarmotoMapTheme(map, colorScheme);
    appliedColorSchemeRef.current = colorScheme;
  }, [colorScheme, ready]);

  const drawableCount = useMemo(() => {
    if (load.phase !== "ready") return 0;
    return load.routes.filter((r) => r.lines.some((l) => l.length >= 2)).length;
  }, [load]);

  if (load.phase === "loading") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 h-72 flex items-center justify-center text-sm text-slate-500">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading map…
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6 text-center text-sm text-amber-200"
      >
        Couldn&apos;t load the route preview right now.
        <p className="mt-1 text-[11px] text-slate-500">{load.message}</p>
      </div>
    );
  }
  if (load.routes.length === 0 || drawableCount === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 h-48 flex flex-col items-center justify-center text-sm text-slate-500 px-6 text-center">
        <MapPin size={24} className="text-slate-600 mb-2" aria-hidden="true" />
        {load.routes.length === 0
          ? "No routes to preview yet."
          : "These routes don't have map data attached."}
      </div>
    );
  }

  return (
    <div className="relative w-full h-72 sm:h-96 rounded-2xl overflow-hidden border border-slate-800">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-2 rounded-full bg-slate-950/80 border border-slate-800 px-3 py-1 text-[11px] text-slate-300">
        <LegendDot color="#22d3ee" /> Trip
        <LegendDot color="#34d399" /> Ride
      </div>
    </div>
  );
}

function LegendDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
