/**
 * Read-only access to the basemap's own OpenStreetMap POIs — the parking, park,
 * info-point and picnic icons the OpenFreeMap ("liberty") style paints from the
 * OpenMapTiles `poi` source-layer. These are NOT our curated `pois`: a feature
 * carries only a name and an OSM class/subclass, so we surface a light card
 * (name + friendly category + a Google Maps link) rather than the rich curated
 * POI detail. Unnamed POIs (a bare parking / bin icon) are exposed too — the
 * card falls back to the category ("Parking", "Waste bin") as its title.
 */

import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import type { EnglishMessageKey, Translate } from "@/i18n";

/** The OpenMapTiles source-layer the basemap POI symbols read from. */
const POI_SOURCE_LAYER = "poi";

/** A clickable basemap POI, projected from an OSM `poi` tile feature. */
export interface BasemapPlace {
  name: string;
  /**
   * Friendly category label in English, e.g. "Parking", "Picnic area". Used
   * only for the Google Maps search query. Rider-facing copy always resolves
   * `categoryKey` through the catalog.
   */
  category: string;
  /**
   * Catalog key for the rider-facing category. Unrecognised subclasses use
   * the generic "Place" key while `category` retains the source token for the
   * external map search.
   */
  categoryKey: EnglishMessageKey;
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
const LABEL_OVERRIDES: Record<string, EnglishMessageKey> = {
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

function uppercaseOsmTokenCharacter(value: string): string {
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search -- OSM class/subclass identifiers are invariant machine tokens whose fallback labels are English source copy.
  return value.toUpperCase();
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, uppercaseOsmTokenCharacter);
}

/**
 * English category label for an OSM poi feature's class/subclass, used only
 * to enrich the external maps search query. Never render this value directly.
 */
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
 * Catalog key for an OSM poi feature's rider-facing category. Unknown source
 * tokens deliberately degrade to the translatable "Place" fallback.
 */
export function basemapPlaceCategoryKey(
  klass: string | undefined,
  subclass: string | undefined,
): EnglishMessageKey {
  const key = subclass || klass || "";
  return LABEL_OVERRIDES[key] ?? LABEL_OVERRIDES[klass ?? ""] ?? "Place";
}

/**
 * The rider-facing category label for a basemap place. The single source of
 * truth for both the popover and the planner consumers that persist a waypoint
 * name, so unknown OSM tokens cannot become English-only saved data.
 */
export function basemapPlaceCategoryDisplay(
  place: BasemapPlace,
  t: Translate,
): string {
  return t(place.categoryKey);
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

/**
 * Project an OSM `poi` tile feature to a BasemapPlace, or null only for a
 * non-point geometry. Unnamed POIs (a bare parking / bin / bench icon) keep an
 * empty `name` — the card falls back to the category as its title.
 */
export function readBasemapPlace(
  feature: MapGeoJSONFeature,
): BasemapPlace | null {
  if (feature.geometry.type !== "Point") return null;
  const props = feature.properties ?? {};
  const name = typeof props.name === "string" ? props.name.trim() : "";
  const [lng, lat] = feature.geometry.coordinates as [number, number];
  const klass = typeof props.class === "string" ? props.class : undefined;
  const subclass =
    typeof props.subclass === "string" ? props.subclass : undefined;
  const category = basemapPlaceCategoryLabel(klass, subclass);
  const categoryKey = basemapPlaceCategoryKey(klass, subclass);
  return {
    name,
    category,
    categoryKey,
    lng,
    lat,
    mapsUrl: basemapPlaceMapsUrl(name || category, lat, lng),
  };
}

/** The topmost basemap place under a click point, or null. */
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
