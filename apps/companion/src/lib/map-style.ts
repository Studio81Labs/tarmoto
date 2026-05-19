import type { Map as MapLibreMap } from "maplibre-gl";

export type MapColorScheme = "light" | "dark";

type ThemeTarget = Pick<MapLibreMap, "getLayer" | "setPaintProperty">;

interface PaintOverride {
  readonly layerIds: readonly string[];
  readonly property: string;
  readonly light: string;
  readonly dark: string;
}

const TRANSPORT_CASING_LAYERS = [
  "road_motorway_link_casing",
  "road_service_track_casing",
  "road_link_casing",
  "road_minor_casing",
  "road_secondary_tertiary_casing",
  "road_trunk_primary_casing",
  "road_motorway_casing",
  "bridge_motorway_link_casing",
  "bridge_service_track_casing",
  "bridge_link_casing",
  "bridge_street_casing",
  "bridge_path_pedestrian_casing",
  "bridge_secondary_tertiary_casing",
  "bridge_trunk_primary_casing",
  "bridge_motorway_casing",
  "tunnel_motorway_link_casing",
  "tunnel_service_track_casing",
  "tunnel_link_casing",
  "tunnel_street_casing",
  "tunnel_secondary_tertiary_casing",
  "tunnel_trunk_primary_casing",
  "tunnel_motorway_casing",
] as const;

const TRANSPORT_MINOR_LAYERS = [
  "road_service_track",
  "road_link",
  "road_minor",
  "bridge_service_track",
  "bridge_link",
  "bridge_street",
  "tunnel_service_track",
  "tunnel_link",
  "tunnel_minor",
] as const;

const TRANSPORT_MAJOR_LAYERS = [
  "road_motorway_link",
  "road_secondary_tertiary",
  "road_trunk_primary",
  "road_motorway",
  "bridge_motorway_link",
  "bridge_secondary_tertiary",
  "bridge_trunk_primary",
  "bridge_motorway",
  "tunnel_motorway_link",
  "tunnel_secondary_tertiary",
  "tunnel_trunk_primary",
  "tunnel_motorway",
] as const;

const TRANSPORT_PATH_LAYERS = [
  "road_path_pedestrian",
  "bridge_path_pedestrian",
  "tunnel_path_pedestrian",
] as const;

const RAIL_LAYERS = [
  "road_major_rail",
  "road_major_rail_hatching",
  "road_transit_rail",
  "road_transit_rail_hatching",
  "bridge_major_rail",
  "bridge_major_rail_hatching",
  "bridge_transit_rail",
  "bridge_transit_rail_hatching",
  "tunnel_major_rail",
  "tunnel_major_rail_hatching",
  "tunnel_transit_rail",
  "tunnel_transit_rail_hatching",
] as const;

const WATER_LABEL_LAYERS = [
  "waterway_line_label",
  "water_name_point_label",
  "water_name_line_label",
] as const;

const TEXT_PRIMARY_LAYERS = [
  "label_city",
  "label_city_capital",
  "label_town",
  "label_village",
  "label_state",
  "label_country_1",
  "label_country_2",
  "label_country_3",
] as const;

const TEXT_MUTED_LAYERS = [
  "label_other",
  "poi_r20",
  "poi_r7",
  "poi_r1",
  "poi_transit",
  "road_shield_us",
  "highway-shield-us-interstate",
  "highway-shield-non-us",
] as const;

const PAINT_OVERRIDES: readonly PaintOverride[] = [
  {
    layerIds: ["background"],
    property: "background-color",
    light: "#eef5f3",
    dark: "#06141d",
  },
  {
    layerIds: ["water"],
    property: "fill-color",
    light: "#9dd7f5",
    dark: "#123a52",
  },
  {
    layerIds: ["waterway_tunnel", "waterway_river", "waterway_other"],
    property: "line-color",
    light: "#65c7e8",
    dark: "#1992b8",
  },
  {
    layerIds: ["park", "landuse_pitch", "landuse_track"],
    property: "fill-color",
    light: "#d4ecd2",
    dark: "#0f2f25",
  },
  {
    layerIds: ["park_outline"],
    property: "line-color",
    light: "#8ebc9d",
    dark: "#2f6b52",
  },
  {
    layerIds: ["landcover_wood"],
    property: "fill-color",
    light: "#bfdcbb",
    dark: "#123525",
  },
  {
    layerIds: ["landcover_grass"],
    property: "fill-color",
    light: "#dcedc7",
    dark: "#173b2a",
  },
  {
    layerIds: ["landcover_wetland"],
    property: "fill-color",
    light: "#b8e0d0",
    dark: "#143c40",
  },
  {
    layerIds: ["landuse_residential"],
    property: "fill-color",
    light: "#f3eee5",
    dark: "#111827",
  },
  {
    layerIds: ["landcover_sand"],
    property: "fill-color",
    light: "#e8d7a1",
    dark: "#394150",
  },
  {
    layerIds: ["aeroway_fill"],
    property: "fill-color",
    light: "#e0e7ef",
    dark: "#1f2937",
  },
  {
    layerIds: ["aeroway_runway", "aeroway_taxiway"],
    property: "line-color",
    light: "#bcc9d8",
    dark: "#475569",
  },
  {
    layerIds: TRANSPORT_CASING_LAYERS,
    property: "line-color",
    light: "#cfd8dc",
    dark: "#0f172a",
  },
  {
    layerIds: TRANSPORT_MINOR_LAYERS,
    property: "line-color",
    light: "#f8fafc",
    dark: "#475569",
  },
  {
    layerIds: TRANSPORT_MAJOR_LAYERS,
    property: "line-color",
    light: "#f0f9ff",
    dark: "#94a3b8",
  },
  {
    layerIds: TRANSPORT_PATH_LAYERS,
    property: "line-color",
    light: "#dbeafe",
    dark: "#334155",
  },
  {
    layerIds: RAIL_LAYERS,
    property: "line-color",
    light: "#94a3b8",
    dark: "#64748b",
  },
  {
    layerIds: ["building"],
    property: "fill-color",
    light: "#d9d4cb",
    dark: "#1e293b",
  },
  {
    layerIds: ["building"],
    property: "fill-outline-color",
    light: "#c7c1b8",
    dark: "#334155",
  },
  {
    layerIds: ["building-3d"],
    property: "fill-extrusion-color",
    light: "#d9d4cb",
    dark: "#243244",
  },
  {
    layerIds: ["boundary_3", "boundary_2", "boundary_disputed"],
    property: "line-color",
    light: "#94a3b8",
    dark: "#475569",
  },
  {
    layerIds: TEXT_PRIMARY_LAYERS,
    property: "text-color",
    light: "#0f172a",
    dark: "#f8fafc",
  },
  {
    layerIds: TEXT_PRIMARY_LAYERS,
    property: "text-halo-color",
    light: "#f8fafc",
    dark: "#06141d",
  },
  {
    layerIds: TEXT_MUTED_LAYERS,
    property: "text-color",
    light: "#334155",
    dark: "#cbd5e1",
  },
  {
    layerIds: TEXT_MUTED_LAYERS,
    property: "text-halo-color",
    light: "#f8fafc",
    dark: "#06141d",
  },
  {
    layerIds: WATER_LABEL_LAYERS,
    property: "text-color",
    light: "#0b7285",
    dark: "#7dd3fc",
  },
  {
    layerIds: WATER_LABEL_LAYERS,
    property: "text-halo-color",
    light: "#f8fafc",
    dark: "#06141d",
  },
] as const;

export function applyTarmotoMapTheme(
  map: ThemeTarget,
  colorScheme: MapColorScheme,
): void {
  for (const override of PAINT_OVERRIDES) {
    const value = override[colorScheme];

    for (const layerId of override.layerIds) {
      if (!map.getLayer(layerId)) continue;
      map.setPaintProperty(layerId, override.property, value);
    }
  }
}
