"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { Map, Layer, Source, Marker } from "react-map-gl/maplibre";
import { MAP_STYLE_URL } from "@/lib/config";
import { useMapColorScheme } from "@/hooks/useMapColorScheme";
import { applyTarmotoMapTheme, type MapColorScheme } from "@/lib/map-style";
import { formatRoadQualityColor } from "@/lib/best-roads-format";
import type { BestRoad } from "@/lib/bestRoads";
import type { FeatureCollection, LineString } from "geojson";
import { useFormat } from "@/format/FormatProvider";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

type Road = Pick<BestRoad, "id" | "road_name" | "quality_score" | "geometry">;

interface Props {
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  defaultZoom: number;
  roads: Road[];
}

export function BestRoadsMap({ bbox, center, defaultZoom, roads }: Props) {
  const format = useFormat();
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const colorScheme = useMapColorScheme();
  const appliedColorSchemeRef = useRef<MapColorScheme | null>(null);

  // Skip roads with < 2 points: a LineString with one or zero coordinates is
  // invalid per RFC 7946 and MapLibre rejects the whole source.
  const featureCollection = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: "FeatureCollection",
      features: roads.flatMap((r, i) => {
        if (r.geometry.length < 2) return [];
        return [
          {
            type: "Feature" as const,
            properties: {
              id: r.id,
              rank: i + 1,
              color: formatRoadQualityColor(r.quality_score),
            },
            geometry: {
              type: "LineString" as const,
              coordinates: r.geometry.map((p) => [p.lng, p.lat]),
            },
          },
        ];
      }),
    }),
    [roads],
  );

  // flatMap (not filter → map) so a road with a degenerate geometry is
  // skipped without renumbering the ranks of everything after it in the
  // list. Use the same `< 2` threshold as the feature collection so no
  // marker is ever drawn without its polyline underneath.
  // A PUBLIC, logged-out road-quality overlay — the only one on the companion
  // that anonymous visitors see, and a standalone react-map-gl map, so it never
  // passed through the `MapCanvas` gate.
  //
  // The rank pins go with the line rather than staying behind: the ranking is a
  // quality ranking, and numbered pins floating over a basemap with no roads
  // drawn would read as broken rather than as switched off.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  const markers = useMemo(
    () =>
      roads.flatMap((r, i) => {
        if (r.geometry.length < 2) return [];
        const mid = r.geometry[Math.floor(r.geometry.length / 2)];
        if (!mid) return [];
        return [{ id: r.id, rank: i + 1, lat: mid.lat, lng: mid.lng }];
      }),
    [roads],
  );

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready || appliedColorSchemeRef.current === colorScheme) return;
    applyTarmotoMapTheme(map, colorScheme);
    appliedColorSchemeRef.current = colorScheme;
  }, [colorScheme, ready]);

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border border-line">
      <Map
        ref={mapRef}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: defaultZoom,
        }}
        mapStyle={MAP_STYLE_URL}
        style={{ width: "100%", height: "100%" }}
        onLoad={() => {
          const map = mapRef.current?.getMap();
          if (map) {
            applyTarmotoMapTheme(map, colorScheme);
            appliedColorSchemeRef.current = colorScheme;
          }
          setReady(true);
          mapRef.current?.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 40, duration: 0 },
          );
        }}
      >
        {qualityOverlayEnabled && (
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
        )}
        {qualityOverlayEnabled &&
          markers.map((m) => (
            <Marker
              key={m.id}
              latitude={m.lat}
              longitude={m.lng}
              anchor="center"
            >
              <a
                href={`#road-${m.id}`}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs font-bold text-cream ring-2 ring-accent"
              >
                {format.number(m.rank, {
                  useGrouping: false,
                  maximumFractionDigits: 0,
                })}
              </a>
            </Marker>
          ))}
      </Map>
    </div>
  );
}
