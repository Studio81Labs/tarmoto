/**
 * Read-only access to the basemap's own OpenStreetMap POIs — the parking, park,
 * info-point and picnic icons the OpenFreeMap ("liberty") style paints from the
 * OpenMapTiles `poi` source-layer. These are NOT our curated `pois`: a feature
 * carries only a name and an OSM class/subclass, so we surface a light card
 * (name + friendly category + a Google Maps link) rather than the rich curated
 * POI detail. Only NAMED points are exposed — unnamed OSM markers are skipped so
 * the map doesn't fill with empty cards.
 */

import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";

/** The OpenMapTiles source-layer the basemap POI symbols read from. */
const POI_SOURCE_LAYER = "poi";

/** A clickable basemap POI, projected from an OSM `poi` tile feature. */
export interface BasemapPlace {
  name: string;
  /** Friendly category label, e.g. "Parking", "Picnic area". */
  category: string;
  lng: number;
  lat: number;
  /** Google Maps link built from the name + coordinates. */
  mapsUrl: string;
}

/**
 * Symbol layer ids in the active style backed by the OMT `poi` source-layer.
 * Enumerated from the live style so a different basemap (env override) still
 * works instead of hard-coding `poi_r1`/`poi_r7`/`poi_r20`/`poi_transit`.
 */
export function getBasemapPoiLayerIds(map: MapLibreMap): string[] {
  const layers = map.getStyle?.()?.layers ?? [];
  return layers
    .filter(
      (layer) =>
        layer.type === "symbol" &&
        (layer as { "source-layer"?: string })["source-layer"] ===
          POI_SOURCE_LAYER,
    )
    .map((layer) => layer.id);
}

// Nicer labels for the common OSM classes/subclasses; anything else falls back
// to a title-cased subclass. Keyed by subclass first, then class.
const LABEL_OVERRIDES: Record<string, string> = {
  parking: "Parking",
  bicycle_parking: "Bike parking",
  waste_basket: "Waste bin",
  drinking_water: "Drinking water",
  picnic_site: "Picnic area",
  information: "Information",
  viewpoint: "Viewpoint",
  fuel: "Petrol station",
  charging_station: "EV charging",
  park: "Park",
  garden: "Garden",
  toilets: "Toilets",
  bench: "Bench",
  cafe: "Café",
  restaurant: "Restaurant",
  fast_food: "Fast food",
  bar: "Bar",
  pub: "Pub",
  hotel: "Hotel",
  hostel: "Hostel",
  guest_house: "Guest house",
  camp_site: "Campsite",
  supermarket: "Supermarket",
  convenience: "Convenience store",
  pharmacy: "Pharmacy",
  hospital: "Hospital",
  atm: "ATM",
  bank: "Bank",
  bus_stop: "Bus stop",
  bus: "Bus stop",
  station: "Station",
  rail: "Railway station",
  attraction: "Attraction",
  museum: "Museum",
};

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Friendly category label for an OSM poi feature's class/subclass. */
export function basemapPlaceCategoryLabel(
  klass: string | undefined,
  subclass: string | undefined,
): string {
  const key = subclass || klass || "";
  return (
    LABEL_OVERRIDES[key] ??
    LABEL_OVERRIDES[klass ?? ""] ??
    (key ? titleCase(key) : "Place")
  );
}

/**
 * Google Maps link for a named coordinate. Searching by name AND coordinates
 * lands on the actual place rather than dropping a bare pin.
 */
export function basemapPlaceMapsUrl(
  name: string,
  lat: number,
  lng: number,
): string {
  const query = encodeURIComponent(`${name} ${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** Project an OSM `poi` tile feature to a BasemapPlace, or null if unusable. */
export function readBasemapPlace(
  feature: MapGeoJSONFeature,
): BasemapPlace | null {
  if (feature.geometry.type !== "Point") return null;
  const props = feature.properties ?? {};
  const name = typeof props.name === "string" ? props.name.trim() : "";
  if (!name) return null;
  const [lng, lat] = feature.geometry.coordinates as [number, number];
  const klass = typeof props.class === "string" ? props.class : undefined;
  const subclass =
    typeof props.subclass === "string" ? props.subclass : undefined;
  return {
    name,
    category: basemapPlaceCategoryLabel(klass, subclass),
    lng,
    lat,
    mapsUrl: basemapPlaceMapsUrl(name, lat, lng),
  };
}

/** The topmost NAMED basemap place under a click point, or null. */
export function topBasemapPlaceAt(
  map: MapLibreMap,
  point: { x: number; y: number },
  layerIds: readonly string[],
): BasemapPlace | null {
  const present = layerIds.filter((id) => map.getLayer(id));
  if (present.length === 0) return null;
  // A [x, y] tuple is a valid PointLike (the caller passes an event's `point`).
  const hits = map.queryRenderedFeatures([point.x, point.y], {
    layers: present,
  });
  for (const hit of hits) {
    const place = readBasemapPlace(hit);
    if (place) return place;
  }
  return null;
}
