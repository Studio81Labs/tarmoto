"use client";

import { useEffect, useRef, useState } from "react";
import type {
  GeoJSONSource,
  LngLatBoundsLike,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/MapCanvas";

const RING_SOURCE_ID = "radius-ring";
const PIN_SOURCE_ID = "radius-pin";

interface Props {
  lat: number;
  lng: number;
  km: number;
  label?: string;
  className?: string;
}

/**
 * Non-interactive mini map: the picked place with a ring at the search
 * radius. Gives the radius choice a physical read ("does 25 km cover the
 * valley?") instead of an abstract number. Camera always frames the ring;
 * panning/zooming are disabled so it stays a preview, not a map.
 */
export function RadiusPreviewMap({
  lat,
  lng,
  km,
  label = "Search radius preview",
  className = "h-[150px]",
}: Props) {
  const handleRef = useRef<MapCanvasHandle>(null);
  const [ready, setReady] = useState(false);

  const handleReady = (map: MapLibreMap) => {
    for (const control of [
      map.dragPan,
      map.scrollZoom,
      map.doubleClickZoom,
      map.touchZoomRotate,
      map.keyboard,
      map.boxZoom,
      map.dragRotate,
    ]) {
      control.disable();
    }
    ensureLayers(map);
    setReady(true);
  };

  useEffect(() => {
    const map = handleRef.current?.map;
    if (!map || !ready) return;
    ensureLayers(map);
    const ring = ringPolygon(lat, lng, km);
    (map.getSource(RING_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
      featureCollection(ring),
    );
    (map.getSource(PIN_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
      featureCollection(pinPoint(lat, lng)),
    );
    map.fitBounds(ringBounds(lat, lng, km), {
      padding: 18,
      // A short ease makes radius changes read as the ring growing or
      // shrinking in place rather than the map cutting.
      duration: 250,
    });
  }, [lat, lng, km, ready]);

  return (
    <div
      aria-label={label}
      role="img"
      className={`pointer-events-none relative w-full overflow-hidden rounded-[10px] border border-line ${className}`}
    >
      <MapCanvas
        ref={handleRef}
        center={{ lat, lng }}
        zoom={8}
        showQuality={false}
        showSurface={false}
        onReady={handleReady}
      />
    </div>
  );
}

function ensureLayers(map: MapLibreMap): void {
  if (!map.getSource(RING_SOURCE_ID)) {
    map.addSource(RING_SOURCE_ID, {
      type: "geojson",
      data: featureCollection(),
    });
  }
  if (!map.getSource(PIN_SOURCE_ID)) {
    map.addSource(PIN_SOURCE_ID, {
      type: "geojson",
      data: featureCollection(),
    });
  }
  if (!map.getLayer("radius-ring-fill")) {
    map.addLayer({
      id: "radius-ring-fill",
      type: "fill",
      source: RING_SOURCE_ID,
      paint: { "fill-color": "#FF6A1A", "fill-opacity": 0.08 },
    });
  }
  if (!map.getLayer("radius-ring-line")) {
    map.addLayer({
      id: "radius-ring-line",
      type: "line",
      source: RING_SOURCE_ID,
      paint: {
        "line-color": "#FF6A1A",
        "line-width": 2,
        "line-dasharray": [2, 1.5],
      },
    });
  }
  if (!map.getLayer("radius-pin")) {
    map.addLayer({
      id: "radius-pin",
      type: "circle",
      source: PIN_SOURCE_ID,
      paint: {
        "circle-radius": 5,
        "circle-color": "#0E0E10",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#F4EDE1",
      },
    });
  }
}

/** Degrees of latitude/longitude spanned by `km` at this latitude. */
function radiusDegrees(
  lat: number,
  km: number,
): { dLat: number; dLng: number } {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { dLat, dLng };
}

function ringPolygon(lat: number, lng: number, km: number): Feature<Polygon> {
  const { dLat, dLng } = radiusDegrees(lat, km);
  const steps = 64;
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    coordinates.push([
      lng + dLng * Math.cos(theta),
      lat + dLat * Math.sin(theta),
    ]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coordinates] },
  };
}

function pinPoint(lat: number, lng: number): Feature<Point> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

function ringBounds(lat: number, lng: number, km: number): LngLatBoundsLike {
  const { dLat, dLng } = radiusDegrees(lat, km);
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat + dLat],
  ];
}

function featureCollection(
  ...features: Feature<Polygon | Point>[]
): FeatureCollection<Polygon | Point> {
  return { type: "FeatureCollection", features };
}
