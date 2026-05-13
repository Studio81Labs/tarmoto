"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import type { FeatureCollection, LineString } from "geojson";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";
import type { RoutePoint } from "@/lib/ride-detail";

const ROUTE_SOURCE_ID = "ride-route";
const ROUTE_LAYER_ID = "ride-route-line";
const DEFAULT_CENTER = { lng: 14.4378, lat: 50.0755 };

interface Props {
  geometry: readonly RoutePoint[];
  label?: string;
  color?: string;
  fitBounds?: RouteMapBounds | null;
}

export function RideRouteMap({
  geometry,
  label = "Ride route map",
  color = "#22d3ee",
  fitBounds,
}: Props) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const [ready, setReady] = useState(false);
  const collection = useMemo(
    () => buildRideRouteCollection(geometry),
    [geometry],
  );
  const center = useMemo(
    () => boundsCenter(fitBounds) ?? routeCenter(geometry) ?? DEFAULT_CENTER,
    [fitBounds, geometry],
  );

  const handleReady = (map: MapLibreMap) => {
    ensureRideRouteLayer(map, color);
    setReady(true);
  };

  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    ensureRideRouteLayer(map, color);
    const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(collection);
    fitRoute(map, collection, fitBounds);
  }, [collection, color, fitBounds, ready]);

  return (
    <div
      className="relative h-[360px] min-h-[280px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
      aria-label={label}
    >
      <MapCanvas
        ref={handleRef}
        center={center}
        zoom={10}
        showQuality={true}
        showSurface={false}
        qualityOpacityExpression={0.45}
        onReady={handleReady}
      />
    </div>
  );
}

function ensureRideRouteLayer(map: MapLibreMap, color: string): void {
  if (!map.getSource(ROUTE_SOURCE_ID)) {
    map.addSource(ROUTE_SOURCE_ID, {
      type: "geojson",
      data: emptyRouteCollection(),
    });
  }
  if (!map.getLayer(ROUTE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_LAYER_ID,
      type: "line",
      source: ROUTE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 5, 16, 8],
        "line-opacity": 0.95,
      },
    });
  } else {
    map.setPaintProperty(ROUTE_LAYER_ID, "line-color", color);
  }
}

function buildRideRouteCollection(
  geometry: readonly RoutePoint[],
): FeatureCollection<LineString> {
  const coordinates = geometry
    .filter(isValidRoutePoint)
    .map((point) => [point.lng, point.lat]);
  if (coordinates.length < 2) return emptyRouteCollection();
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      },
    ],
  };
}

function emptyRouteCollection(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}

function fitRoute(
  map: MapLibreMap,
  collection: FeatureCollection<LineString>,
  fitBounds?: RouteMapBounds | null,
): void {
  const bounds = new maplibregl.LngLatBounds();
  if (fitBounds) {
    bounds.extend([fitBounds.minLng, fitBounds.minLat]);
    bounds.extend([fitBounds.maxLng, fitBounds.maxLat]);
  } else {
    const coordinates = collection.features[0]?.geometry.coordinates;
    if (!coordinates?.length) return;
    for (const coordinate of coordinates) {
      bounds.extend(coordinate as [number, number]);
    }
  }
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds as LngLatBoundsLike, {
      padding: 42,
      maxZoom: 15,
      duration: 0,
    });
  }
}

export interface RouteMapBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function boundsCenter(
  bounds: RouteMapBounds | null | undefined,
): { lng: number; lat: number } | null {
  if (!bounds) return null;
  return {
    lng: (bounds.minLng + bounds.maxLng) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2,
  };
}

function routeCenter(
  geometry: readonly RoutePoint[],
): { lng: number; lat: number } | null {
  const valid = geometry.filter(isValidRoutePoint);
  if (valid.length === 0) return null;
  const sum = valid.reduce(
    (acc, point) => ({
      lng: acc.lng + point.lng,
      lat: acc.lat + point.lat,
    }),
    { lng: 0, lat: 0 },
  );
  return { lng: sum.lng / valid.length, lat: sum.lat / valid.length };
}

function isValidRoutePoint(point: RoutePoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}
