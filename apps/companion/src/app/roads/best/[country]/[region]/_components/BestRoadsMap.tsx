"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useMemo, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { Map, Layer, Source, Marker } from "react-map-gl/maplibre";
import { MAP_STYLE_URL } from "@/lib/config";
import type { FeatureCollection, LineString } from "geojson";

interface Road {
  id: string;
  road_name: string | null;
  quality_score: number | null;
  geometry: { lat: number; lng: number }[];
}

interface Props {
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  defaultZoom: number;
  roads: Road[];
}

// Keep in sync with the quality tier colors used on the explorer heatmap.
const QUALITY_COLOR = (q: number | null): string => {
  if (q == null) return "#64748B";
  if (q >= 4.5) return "#22C55E";
  if (q >= 3.5) return "#84CC16";
  if (q >= 2.5) return "#EAB308";
  if (q >= 1.5) return "#F97316";
  return "#EF4444";
};

export function BestRoadsMap({ bbox, center, defaultZoom, roads }: Props) {
  const mapRef = useRef<MapRef | null>(null);

  const featureCollection = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: "FeatureCollection",
      features: roads.map((r, i) => ({
        type: "Feature",
        properties: {
          id: r.id,
          rank: i + 1,
          color: QUALITY_COLOR(r.quality_score),
        },
        geometry: {
          type: "LineString",
          coordinates: r.geometry.map((p) => [p.lng, p.lat]),
        },
      })),
    }),
    [roads],
  );

  // flatMap (not filter → map) so a road with an empty geometry is skipped
  // without renumbering the ranks of everything after it in the list.
  const markers = useMemo(
    () =>
      roads.flatMap((r, i) => {
        if (r.geometry.length === 0) return [];
        const mid = r.geometry[Math.floor(r.geometry.length / 2)];
        return [{ id: r.id, rank: i + 1, lat: mid.lat, lng: mid.lng }];
      }),
    [roads],
  );

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border border-slate-800">
      <Map
        ref={mapRef}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: defaultZoom,
        }}
        mapStyle={MAP_STYLE_URL}
        style={{ width: "100%", height: "100%" }}
        attributionControl={true}
        onLoad={() => {
          mapRef.current?.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 40, duration: 0 },
          );
        }}
      >
        <Source id="best-roads" type="geojson" data={featureCollection}>
          <Layer
            id="best-roads-line"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": 4,
              "line-opacity": 0.9,
            }}
            layout={{ "line-cap": "round", "line-join": "round" }}
          />
        </Source>
        {markers.map((m) => (
          <Marker key={m.id} latitude={m.lat} longitude={m.lng} anchor="center">
            <a
              href={`#road-${m.id}`}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white ring-2 ring-tarmoto-cyan"
            >
              {m.rank}
            </a>
          </Marker>
        ))}
      </Map>
    </div>
  );
}
