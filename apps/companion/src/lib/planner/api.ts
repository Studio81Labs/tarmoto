import {
  createFormatters,
  DEFAULT_FORMAT_LOCALE,
  haversineKm,
  SURFACE_TYPES,
  type Formatters,
  type SurfaceType,
} from "@tarmoto/shared";
import {
  api,
  passesApi,
  poiApi,
  roadsApi,
  routingApi,
  usersApi,
  type AccommodationSuggestion,
  type MountainPass,
  type RouteQualitySegment,
  type PoiKind,
  type RouteRequestBody,
  type RouteResponse,
  type RoutePoiSuggestion,
  type StoredPoiSuggestion,
  type StoredCorridorPoiSuggestion,
  type UserRoutePrefsWire,
} from "@/lib/api";
import { sampleRoutePoints } from "@/lib/route-sampling";
import {
  fetchFunZonesInBbox,
  fetchFunZonesInCorridor,
  type FunZoneListItem,
} from "@/lib/discover";
import { deriveQualitySegments } from "./derive";
import { mapRouteQualitySpans } from "./route-quality";
import {
  corridorBbox,
  draftViasThroughZones,
  funZoneCentroid,
  zonesNearCorridor,
  MAX_DRAFT_VIAS,
  type DraftZone,
} from "./draft-vias";
import { API_HOST } from "@/lib/config";
import { nearestPolygonContact, projectOntoRoute } from "./route-projection";
import { cumulativeKm, pointAtDistanceKm, type LngLat } from "./polyline";
import { SURFACE_VALUES, type UserRoutePrefs } from "./prefs";
import type {
  DraftOptions,
  DraftRouteResult,
  DraftRoundtripResult,
  FlaggedSection,
  GeneratedPlannerRoute,
  GeoResult,
  PlannerApi,
  PlannerPoi,
  PlannerPoiType,
  Poi,
  PoiCategory,
  RoadPreview,
  RouteStop,
  RoundtripOptions,
  RouteQualitySummary,
  RouteSegment,
} from "./types";
import { coalesceQualityRuns } from "./quality-bands";

/**
 * The planner's single data seam. Real sources: backend Valhalla routing
 * (`routingApi`), the `/poi/*` endpoints, per-segment surface quality
 * (`roadsApi.getRouteQuality`, mapped in `./route-quality`), and geocoding
 * (`api` → `/api/v1/geocode` + `/geocode/reverse`). Mock sources (see
 * `./mocks/`): road previews. Swapping a mock for its real source only ever
 * touches this file.
 */

const SURFACE_TYPE_SET: ReadonlySet<string> = new Set(SURFACE_TYPES);

function asSurfaceType(key: string): SurfaceType {
  return SURFACE_TYPE_SET.has(key) ? (key as SurfaceType) : "unknown";
}

// The backend rejects a single /route-quality request over its route-length
// limit (MAX_ROUTE_QUALITY_LENGTH_M = 500 km, roads.service.ts); keep each
// request safely under it.
const MAX_ROUTE_QUALITY_REQUEST_KM = 480;

// The endpoint also caps a request at MAX_ROUTE_QUALITY_POINTS (25 000 vertices,
// route-quality.dto.ts); a dense but short route can exceed that under the km
// limit, so chunk by vertex count too. Kept under the cap with margin.
const MAX_ROUTE_QUALITY_REQUEST_POINTS = 20000;

// A route-quality response describes public road data for an exact polyline.
// Keep a small, session-local cache so preference changes or a save/refetch
// that produces the identical GraphHopper geometry does not repeat thousands
// of PostGIS nearest-segment lookups. Nothing is persisted, and the short TTL
// matches the map tile browser freshness window.
const ROUTE_QUALITY_CACHE_TTL_MS = 5 * 60_000;
const MAX_ROUTE_QUALITY_CACHE_ENTRIES = 8;

interface CachedRouteQuality {
  expiresAt: number;
  spans: RouteQualitySegment[];
}

function routeQualityCacheKey(
  points: ReadonlyArray<{ lat: number; lng: number }>,
): string {
  return points.map((point) => `${point.lat},${point.lng}`).join(";");
}

interface RouteChunk {
  points: { lat: number; lng: number }[];
  /** Where this chunk starts on the whole route, as a fraction [0,1]. */
  startFraction: number;
  /** This chunk's share of the whole route length, as a fraction. */
  fractionSpan: number;
}

/**
 * Insert interpolated points so no single edge exceeds `maxKm`. A sparse or
 * heavily simplified imported line (e.g. a 2-point GPX hop over the limit) has
 * edges longer than any chunk could be split at existing vertices; cutting
 * inside them lets {@link chunkRouteByLengthKm} keep every chunk under the
 * limit. Points lie on the straight lat/lng segment — exactly the rendered
 * line — so the added vertices don't distort the route.
 */
function densifyMaxEdgeKm(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  maxKm: number,
): { lat: number; lng: number }[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: { lat: number; lng: number }[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const edgeKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
    if (edgeKm > maxKm) {
      const cuts = Math.ceil(edgeKm / maxKm);
      for (let k = 1; k < cuts; k += 1) {
        const t = k / cuts;
        out.push({
          lat: a.lat + (b.lat - a.lat) * t,
          lng: a.lng + (b.lng - a.lng) * t,
        });
      }
    }
    out.push({ ...b });
  }
  return out;
}

/**
 * Split a routed polyline into contiguous chunks under both the backend's
 * per-request length limit (`maxKm`) and vertex limit (`maxPoints`), so a long
 * OR dense day still gets real quality. Long edges are first densified so a
 * sparse imported line can be cut inside them. Chunks share their boundary
 * vertex (gap-free) and record where they sit on the whole route so per-chunk
 * quality fractions can be remapped back onto it.
 */
function chunkRouteByLengthKm(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  maxKm: number,
  maxPoints: number,
): RouteChunk[] {
  const dense = densifyMaxEdgeKm(points, maxKm);
  const cum: number[] = [0];
  for (let i = 1; i < dense.length; i += 1) {
    const a = dense[i - 1]!;
    const b = dense[i]!;
    cum.push((cum[i - 1] ?? 0) + haversineKm(a.lat, a.lng, b.lat, b.lng));
  }
  const total = cum[cum.length - 1] ?? 0;
  if (dense.length < 2 || (total <= maxKm && dense.length <= maxPoints)) {
    return [
      {
        points: dense.map((p) => ({ ...p })),
        startFraction: 0,
        fractionSpan: total > 0 ? 1 : 0,
      },
    ];
  }
  const chunks: RouteChunk[] = [];
  let startIdx = 0;
  while (startIdx < dense.length - 1) {
    const startKm = cum[startIdx] ?? 0;
    let endIdx = startIdx + 1;
    while (
      endIdx + 1 <= dense.length - 1 &&
      (cum[endIdx + 1] ?? 0) - startKm <= maxKm &&
      // keep the chunk (endIdx + 1 - startIdx + 1 vertices) under the cap
      endIdx + 2 - startIdx <= maxPoints
    ) {
      endIdx += 1;
    }
    const endKm = cum[endIdx] ?? 0;
    chunks.push({
      points: dense.slice(startIdx, endIdx + 1).map((p) => ({ ...p })),
      startFraction: total > 0 ? startKm / total : 0,
      fractionSpan: total > 0 ? (endKm - startKm) / total : 0,
    });
    if (endIdx >= dense.length - 1) break;
    startIdx = endIdx; // next chunk shares this boundary vertex
  }
  return chunks;
}

/** `surface_mix` arrives as metres per surface; render as whole-number %. */
export function surfaceMixToPercents(
  surfaceMixMetres: Record<string, number>,
): RouteQualitySummary["surfaceMix"] {
  const metresBySurface = new Map<SurfaceType, number>();
  let total = 0;
  for (const [key, metres] of Object.entries(surfaceMixMetres)) {
    if (!(metres > 0)) continue;
    const surface = asSurfaceType(key);
    metresBySurface.set(surface, (metresBySurface.get(surface) ?? 0) + metres);
    total += metres;
  }
  if (total === 0) return [];
  return (
    [...metresBySurface.entries()]
      .map(([surface, metres]) => ({
        surface,
        pct: Math.round((metres / total) * 100),
      }))
      // Drop sub-1% surfaces: they round to 0, contribute a 0-width bar slice,
      // and would otherwise show a misleading "0% asphalt" chip in the legend.
      .filter((entry) => entry.pct > 0)
      .sort((a, b) => b.pct - a.pct)
  );
}

export function deriveFlaggedSections(
  segments: readonly RouteSegment[],
): FlaggedSection[] {
  const flagged: FlaggedSection[] = [];
  // Coalesce adjacent same-band runs so a long rough/uncovered stretch is one
  // card, not one per ~100 m segment.
  for (const run of coalesceQualityRuns(segments)) {
    const lengthKm = Math.round(run.lengthKm * 10) / 10;
    if (run.band === "rough") {
      flagged.push({
        segmentId: run.id,
        kind: "rough",
        lengthKm,
        surface: run.surface,
      });
    } else if (run.band === "no_data") {
      flagged.push({
        segmentId: run.id,
        kind: "no_data",
        lengthKm,
      });
    }
  }
  return flagged;
}

export function buildRouteQualitySummary(
  raw: RouteResponse,
  segments: readonly RouteSegment[],
): RouteQualitySummary {
  return {
    distanceKm: raw.distance_km,
    timeMin: raw.duration_min,
    score: raw.avg_quality,
    surfaceMix: surfaceMixToPercents(raw.surface_mix),
    flagged: deriveFlaggedSections(segments),
  };
}

const ALONG_ROUTE_KIND_BY_TYPE: Partial<Record<PlannerPoiType, PoiKind>> = {
  fuel: "fuel_station",
  restaurant: "restaurant",
  cafe: "cafe",
  viewpoint: "viewpoint",
};

const TYPE_BY_ALONG_ROUTE_KIND: Record<PoiKind, PlannerPoiType> = {
  fuel_station: "fuel",
  restaurant: "restaurant",
  cafe: "cafe",
  viewpoint: "viewpoint",
};

function alongRoutePoiToPlannerPoi(poi: RoutePoiSuggestion): PlannerPoi {
  return {
    id: poi.external_id,
    type: TYPE_BY_ALONG_ROUTE_KIND[poi.kind],
    // Empty is semantic "source supplied no name"; render boundaries choose a
    // cataloged fallback for the active locale.
    name: poi.name?.trim() ?? "",
    lat: poi.lat,
    lng: poi.lng,
    distanceFromRouteKm: poi.distance_from_route_km,
    kmAlongRoute: poi.distance_along_route_km,
  };
}

function accommodationToPlannerPoi(stay: AccommodationSuggestion): PlannerPoi {
  return {
    id: stay.external_id,
    type: "stay",
    name: stay.name?.trim() ?? "",
    poiCategory: stay.kind === "camp_site" ? "campground" : "biker_hotel",
    lat: stay.lat,
    lng: stay.lng,
    distanceFromRouteKm: stay.distance_km,
  };
}

// ── Category POIs (map-top bar, revision 4 §B) ──
// The OSM-backed categories now read the offline `pois` store via
// `/poi/in-bbox` (#856). `mountain_pass` (seasonal-pass source) and
// `twisty_highlight` (Tarmoto curviness layer) are NOT in that store and stay
// on their own source until wired — see `getPoisByCategories`.

/** Companion category → the store `kind`s that back it (OSM categories only). */
const STORE_KINDS_BY_CATEGORY: Partial<Record<PoiCategory, string[]>> = {
  fuel: ["fuel_station"],
  food: ["restaurant", "fast_food", "ice_cream"],
  cafe: ["cafe"],
  viewpoint: ["viewpoint"],
  campground: ["camp_site"],
  biker_hotel: [
    "hotel",
    "motel",
    "guest_house",
    "hostel",
    "chalet",
    "apartment",
  ],
};

/** Reverse map: store `kind` → the companion category it renders under. */
const CATEGORY_BY_STORE_KIND: Record<string, PoiCategory> = Object.entries(
  STORE_KINDS_BY_CATEGORY,
).reduce<Record<string, PoiCategory>>((acc, [category, kinds]) => {
  for (const kind of kinds ?? []) acc[kind] = category as PoiCategory;
  return acc;
}, {});

/** Categories not backed by the `pois` store — kept on their own source. */
const NON_STORE_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>([
  "mountain_pass",
  "twisty_highlight",
]);

function storedPoiToCategoryPoi(poi: StoredPoiSuggestion): Poi | null {
  const category = CATEGORY_BY_STORE_KIND[poi.kind];
  if (!category) return null;
  return {
    id: poi.id,
    category,
    // The store carries the venue's bulk source (#869); pass it through so the
    // map/legend/popover can credit OSM vs Foursquare. Anything unexpected falls
    // back to `osm` (the only pre-FSQ source).
    source: poi.source === "fsq" ? "fsq" : "osm",
    name: poi.name?.trim() ?? "",
    lat: poi.lat,
    lng: poi.lng,
    meta: {
      stars: poi.stars,
      website: poi.website,
      phone: poi.phone,
      openingHours: poi.opening_hours,
      addressStreet: poi.address_street,
      addressCity: poi.address_city,
      cuisine: poi.cuisine,
      brand: poi.brand,
      osmUrl: poi.osm_url,
      mapsUrl: poi.maps_url,
    },
  };
}

/**
 * Map a mountain pass (passes module) to a `mountain_pass` category Poi (#865):
 * the pass point + its seasonal open/closed status and altitude.
 */
function passToCategoryPoi(pass: MountainPass): Poi {
  return {
    id: pass.id,
    category: "mountain_pass",
    source: "passes",
    name: pass.name,
    lat: pass.lat,
    lng: pass.lng,
    meta: { status: pass.status, elevationM: pass.elevation_m },
  };
}

/**
 * Map a Fun Zone (curviness/quality layer) to a `twisty_highlight` Poi at its
 * boundary centroid (#865); null when the ring is unusable. `composite_score`
 * is the twistiness signal, `total_curve_km` the length.
 */
function funZoneToCategoryPoi(zone: FunZoneListItem): Poi | null {
  const centroid = funZoneCentroid(zone);
  if (!centroid) return null;
  return {
    id: zone.id,
    category: "twisty_highlight",
    source: "tarmoto",
    name: zone.name?.trim() ?? "",
    lat: centroid.lat,
    lng: centroid.lng,
    meta: { twistyScore: zone.composite_score, lengthKm: zone.total_curve_km },
  };
}

/**
 * The two non-store categories in a bbox (#865): `mountain_pass` from the
 * passes module (bbox-filtered server-side), `twisty_highlight` from the
 * curviness Fun Zones. Replaces the retired `mockPoisByCategories`.
 */
async function fetchNonStorePois(
  bbox: [number, number, number, number],
  categories: PoiCategory[],
  forMonth?: number,
  init?: { signal?: AbortSignal },
): Promise<Poi[]> {
  const wanted = new Set(categories);
  const [passes, zones] = await Promise.all([
    wanted.has("mountain_pass")
      ? passesApi
          .list(bbox, forMonth, init)
          .then((p) => p.data.map(passToCategoryPoi))
      : Promise.resolve<Poi[]>([]),
    wanted.has("twisty_highlight")
      ? fetchFunZonesInBbox(bbox, init).then((z) =>
          z.map(funZoneToCategoryPoi).filter((p): p is Poi => p !== null),
        )
      : Promise.resolve<Poi[]>([]),
  ]);
  return [...passes, ...zones];
}

/**
 * The two non-store categories along a route (#865, the STOPS tab):
 * `mountain_pass` via `passes/check-route`, `twisty_highlight` via
 * `/roads/fun-zones/in-corridor` — both bounded to the corridor server-side,
 * then projected onto the route client-side (neither corridor endpoint returns
 * along-route distances) for their STOPS position. Replaces `mockRouteStops`
 * for these two.
 */
/** Project a point Poi (a pass) onto the route into a RouteStop; null on a
 *  degenerate route. */
function projectPointStop(
  poi: Poi,
  route: { lat: number; lng: number }[],
): RouteStop | null {
  const projected = projectOntoRoute(poi, route);
  return projected ? { ...poi, ...projected } : null;
}

/**
 * Position a Fun Zone stop on the route. A zone is a polygon the backend
 * selected by polygon proximity (ST_DWithin over the whole geometry), so both
 * the off-route distance AND the stop's own lat/lng come from the on-route
 * contact — NOT the centroid. The row can read "on-route" while the centroid
 * sits far to one side; since the stop's coordinate is what drops a via
 * waypoint and opens the popover (TripPlannerMap), anchoring on the route
 * contact keeps that via on the rider's road instead of detouring to the
 * polygon middle. The bbox/map layer still shows zones at their centroid. No
 * corridor re-filter — trust the server's selection.
 */
function funZoneStop(
  zone: FunZoneListItem,
  route: { lat: number; lng: number }[],
): RouteStop | null {
  const poi = funZoneToCategoryPoi(zone);
  if (!poi) return null;
  const contact = nearestPolygonContact(zone.boundary, route);
  return contact ? { ...poi, ...contact } : null;
}

async function fetchNonStoreStops(
  route: { lat: number; lng: number }[],
  categories: PoiCategory[],
  corridorKm: number,
  forMonth?: number,
  init?: { signal?: AbortSignal },
): Promise<RouteStop[]> {
  const wanted = new Set(categories);
  const bufferM = Math.round(corridorKm * 1000);
  const [passStops, zoneStops] = await Promise.all([
    // Passes are points: the server filtered by the point within `buffer_m`, so
    // re-projecting the same point agrees — keep the corridor guard as defence.
    // `for_month` matches the Conditions overlay's seasonal status; omit it
    // (current month) when unset so the body stays minimal.
    wanted.has("mountain_pass")
      ? passesApi
          .checkRoute(
            {
              route,
              buffer_m: bufferM,
              ...(forMonth !== undefined ? { for_month: forMonth } : {}),
            },
            init,
          )
          .then((res) =>
            res.data.passes
              .map(passToCategoryPoi)
              .map((poi) => projectPointStop(poi, route))
              .filter(
                (s): s is RouteStop =>
                  s !== null && s.distanceFromRouteKm <= corridorKm,
              ),
          )
      : Promise.resolve<RouteStop[]>([]),
    wanted.has("twisty_highlight")
      ? fetchFunZonesInCorridor(route, corridorKm, init).then((zones) =>
          zones
            .map((zone) => funZoneStop(zone, route))
            .filter((s): s is RouteStop => s !== null),
        )
      : Promise.resolve<RouteStop[]>([]),
  ]);
  return [...passStops, ...zoneStops];
}

async function fetchCategoryPois(
  bbox: [number, number, number, number],
  categories: PoiCategory[],
  forMonth?: number,
  init?: { signal?: AbortSignal },
): Promise<Poi[]> {
  // bbox is [west, south, east, north] = [minLng, minLat, maxLng, maxLat].
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const storeCategories = categories.filter(
    (c) => !NON_STORE_CATEGORIES.has(c),
  );
  const nonStoreCategories = categories.filter((c) =>
    NON_STORE_CATEGORIES.has(c),
  );
  const kinds = [
    ...new Set(
      storeCategories.flatMap((c) => STORE_KINDS_BY_CATEGORY[c] ?? []),
    ),
  ];

  const [stored, others] = await Promise.all([
    kinds.length > 0
      ? poiApi
          .getInBbox({ minLng, minLat, maxLng, maxLat, kinds }, init)
          .then((res) =>
            res.data.pois
              .map(storedPoiToCategoryPoi)
              .filter((p): p is Poi => p !== null),
          )
      : Promise.resolve<Poi[]>([]),
    // mountain_pass → passes module, twisty_highlight → curviness Fun Zones,
    // each via its generated bbox endpoint (#865).
    nonStoreCategories.length > 0
      ? fetchNonStorePois(bbox, nonStoreCategories, forMonth, init)
      : Promise.resolve<Poi[]>([]),
  ]);

  return [...stored, ...others];
}

// ── Route-corridor stops (STOPS tab, revision 5 §C) ──
// Same category vocabulary as the map bar, filtered by proximity to the route
// line. OSM categories read the store via `/poi/in-corridor` (#859);
// mountain_pass / twisty_highlight stay on their mock source.

/** Accommodation categories — `minStayRating` only filters these. */
const ACCOMMODATION_CATEGORIES: ReadonlySet<PoiCategory> = new Set<PoiCategory>(
  ["biker_hotel", "campground"],
);

function storedCorridorPoiToRouteStop(
  poi: StoredCorridorPoiSuggestion,
): RouteStop | null {
  const base = storedPoiToCategoryPoi(poi);
  if (!base) return null;
  return {
    ...base,
    distanceFromRouteKm: poi.distance_from_route_km,
    kmAlongRoute: poi.distance_along_route_km,
  };
}

async function fetchCorridorStops(
  routeGeometry: GeoJSON.LineString,
  categories: PoiCategory[],
  corridorKm: number,
  minStayRating?: number,
  forMonth?: number,
  init?: { signal?: AbortSignal },
): Promise<RouteStop[]> {
  const route = routeGeometry.coordinates
    .map((pos) => ({ lng: pos[0], lat: pos[1] }))
    .filter(
      (p): p is { lat: number; lng: number } =>
        p.lat !== undefined && p.lng !== undefined,
    );
  const storeCategories = categories.filter(
    (c) => !NON_STORE_CATEGORIES.has(c),
  );
  const nonStoreCategories = categories.filter((c) =>
    NON_STORE_CATEGORIES.has(c),
  );
  const kinds = [
    ...new Set(
      storeCategories.flatMap((c) => STORE_KINDS_BY_CATEGORY[c] ?? []),
    ),
  ];

  const [stored, others] = await Promise.all([
    kinds.length > 0 && route.length >= 2
      ? poiApi
          .getInCorridor({ route, buffer_km: corridorKm, kinds }, init)
          .then((res) =>
            res.data.pois
              .map(storedCorridorPoiToRouteStop)
              .filter((s): s is RouteStop => s !== null),
          )
      : Promise.resolve<RouteStop[]>([]),
    // mountain_pass → passes/check-route, twisty_highlight → fun-zones
    // corridor, projected onto the route for their STOPS position (#865).
    // `minStayRating` never applied to these (they're not accommodations).
    nonStoreCategories.length > 0 && route.length >= 2
      ? fetchNonStoreStops(
          route,
          nonStoreCategories,
          corridorKm,
          forMonth,
          init,
        )
      : Promise.resolve<RouteStop[]>([]),
  ]);

  // minStayRating applies only to accommodation categories; drop those with a
  // missing or too-low star rating (matches the mock's semantics).
  const filteredStore =
    minStayRating == null
      ? stored
      : stored.filter((s) => {
          if (!ACCOMMODATION_CATEGORIES.has(s.category)) return true;
          const stars = s.meta?.stars;
          return typeof stars === "number" && stars >= minStayRating;
        });

  return [...filteredStore, ...others].sort(
    (a, b) => a.kmAlongRoute - b.kmAlongRoute,
  );
}

async function fetchPois(
  route: ReadonlyArray<{ lat: number; lng: number }>,
  types: PlannerPoiType[],
  init?: { signal?: AbortSignal },
): Promise<PlannerPoi[]> {
  if (route.length === 0 || types.length === 0) return [];

  const alongRouteKinds = types
    .map((type) => ALONG_ROUTE_KIND_BY_TYPE[type])
    .filter((kind): kind is PoiKind => kind !== undefined);
  const finish = route[route.length - 1];

  const [alongRoute, stays] = await Promise.all([
    alongRouteKinds.length > 0
      ? poiApi.getAlongRoute(
          // Downsampled — the check buffers by km and dense polylines
          // can exceed the backend's JSON body limit.
          { route: [...sampleRoutePoints(route)], kinds: alongRouteKinds },
          init,
        )
      : Promise.resolve(null),
    types.includes("stay") && finish
      ? poiApi.getAccommodations({ lat: finish.lat, lng: finish.lng }, init)
      : Promise.resolve(null),
  ]);

  return [
    ...(alongRoute?.data.pois.map(alongRoutePoiToPlannerPoi) ?? []),
    ...(stays?.data.accommodations.map(accommodationToPlannerPoi) ?? []),
  ];
}

/**
 * Overnight-town candidates for day-break snapping: one small
 * accommodations query around each raw break target (real /poi endpoint).
 * A failed query just yields no candidates for that break — the splitter
 * falls back to the raw distance there.
 */
export async function fetchOvernightTowns(
  coordinates: ReadonlyArray<ReadonlyArray<number>>,
  targetKms: readonly number[],
  init?: { signal?: AbortSignal },
): Promise<PlannerPoi[]> {
  if (coordinates.length < 2 || targetKms.length === 0) return [];
  // Cumulative km per vertex to locate each target's coordinate.
  const kms: number[] = [0];
  for (let i = 1; i < coordinates.length; i += 1) {
    const [lng1, lat1] = coordinates[i - 1] ?? [];
    const [lng2, lat2] = coordinates[i] ?? [];
    const step =
      typeof lng1 === "number" &&
      typeof lat1 === "number" &&
      typeof lng2 === "number" &&
      typeof lat2 === "number"
        ? haversineKm(lat1, lng1, lat2, lng2)
        : 0;
    kms.push((kms[i - 1] ?? 0) + step);
  }
  const anchors = targetKms.map((target) => {
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kms.length; i += 1) {
      const delta = Math.abs((kms[i] ?? 0) - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    const [lng, lat] = coordinates[best] ?? [];
    return typeof lng === "number" && typeof lat === "number"
      ? { lat, lng }
      : null;
  });

  const results = await Promise.allSettled(
    anchors.map((anchor) =>
      anchor
        ? poiApi.getAccommodations(
            { lat: anchor.lat, lng: anchor.lng, radius_km: 25 },
            init,
          )
        : Promise.reject(new Error("no anchor")),
    ),
  );
  const towns = new Map<string, PlannerPoi>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const stay of result.value.data.accommodations) {
      const poi = accommodationToPlannerPoi(stay);
      towns.set(poi.id, poi);
    }
  }
  return [...towns.values()];
}

/**
 * One REAL routing round-trip: backend Valhalla proxy. The returned segments
 * are the geometry-only `no_data` baseline — real per-segment quality is
 * fetched separately (`getRouteQuality`) once a day is committed, so the draft
 * sizing loops here never trigger a quality query per measuring route.
 */
async function routeReal(
  waypoints: ReadonlyArray<{ lat: number; lng: number }>,
  options: RouteRequestBody["options"],
  init?: { signal?: AbortSignal; dayNumber?: number },
): Promise<GeneratedPlannerRoute> {
  const { data: raw } = await routingApi.route(
    {
      waypoints: [...waypoints],
      ...(options !== undefined ? { options } : {}),
    },
    init?.signal !== undefined ? { signal: init.signal } : {},
  );
  const segments = deriveQualitySegments(raw.geometry, init?.dayNumber ?? 1);
  return {
    raw,
    segments,
    summary: buildRouteQualitySummary(raw, segments),
  };
}

/** "Close enough" to the soft sizing target (revision 2 §E — soft goal). */
export const DRAFT_TARGET_TOLERANCE = 0.9;
/** Inflation ceiling: stop trading detours once a day balloons past this. */
export const DRAFT_MAX_OVERSHOOT = 1.35;
/** Case 3 "light flavor": zones must sit this close to the direct line. */
export const DRAFT_CORRIDOR_FLAVOR_KM = 25;
/** Zone candidates worth a measuring routing call while inflating. */
const DRAFT_CANDIDATE_LIMIT = 5;

/** Fallback label for a pin the geocoder can't name — trimmed coordinates. */
const DEFAULT_COORDINATE_FORMAT = createFormatters({
  locale: DEFAULT_FORMAT_LOCALE,
  units: "metric",
});

function coordinateLabel(
  lat: number,
  lng: number,
  format: Pick<Formatters, "decimal"> = DEFAULT_COORDINATE_FORMAT,
): string {
  return `${format.decimal(lat, 3)}, ${format.decimal(lng, 3)}`;
}

/** Bearing (deg, 0 = N) from `a` to `b`; undefined for a zero-length edge. */
function bearingBetween(a: LngLat, b: LngLat): number | undefined {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  if (
    typeof lng1 !== "number" ||
    typeof lat1 !== "number" ||
    typeof lng2 !== "number" ||
    typeof lat2 !== "number"
  ) {
    return undefined;
  }
  if (lng1 === lng2 && lat1 === lat2) return undefined;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Local travel heading at `targetKm` along the line — the direction of the edge
 * that spans that distance. Used at the imagery lookup point so a curved or
 * U-shaped run gets the heading THERE, not the end-to-end chord (which could
 * face the opposite way) (#863 review).
 */
function bearingAtDistanceKm(
  coords: readonly LngLat[],
  cum: readonly number[],
  targetKm: number,
): number | undefined {
  for (let i = 1; i < cum.length; i += 1) {
    if ((cum[i] ?? 0) >= targetKm) {
      return bearingBetween(coords[i - 1]!, coords[i]!);
    }
  }
  const last = coords.length - 1;
  return last >= 1
    ? bearingBetween(coords[last - 1]!, coords[last]!)
    : undefined;
}

/**
 * Street-level imagery near a segment's midpoint — Mapillary via the backend
 * proxy (#863). Best-effort: resolves to null on any error / no coverage so the
 * Road Preview renders without a thumbnail rather than failing.
 */
async function fetchSegmentImagery(segment: RouteSegment): Promise<{
  imageUrl: string;
  capturedAt: string | null;
  attribution: string | null;
  link: string | null;
} | null> {
  const coords = segment.geometry.coordinates as LngLat[];
  if (coords.length === 0) return null;
  // Interpolate the point at HALF the polyline distance — not the middle
  // vertex. A long section can be just two vertices, where an index-based
  // midpoint lands on the segment end and queries the next road (#863 review).
  const cum = cumulativeKm(coords);
  const halfKm = (cum[cum.length - 1] ?? 0) / 2;
  const [lng, lat] = pointAtDistanceKm(coords, cum, halfKm);
  // Heading at the SAME point we look up, not the end-to-end chord.
  const bearing = bearingAtDistanceKm(coords, cum, halfKm);
  const { data, error } = await api.GET("/api/v1/roads/segment-imagery", {
    params: {
      query: { lat, lng, ...(bearing !== undefined ? { bearing } : {}) },
    },
  });
  if (error || !data?.imageId) return null;
  return {
    // Load the thumbnail through the backend proxy — the browser never contacts
    // Mapillary's CDN, so the rider IP + viewed section stay private (ADR-0009).
    imageUrl: `${API_HOST}/api/v1/roads/segment-imagery/thumb/${encodeURIComponent(
      data.imageId,
    )}`,
    capturedAt: data.capturedAt,
    attribution: data.attribution,
    link: data.link,
  };
}

export function createPlannerApi(): PlannerApi {
  const routeQualityCache = new Map<string, CachedRouteQuality>();

  return {
    generateRoute(
      waypoints: ReadonlyArray<{ lat: number; lng: number }>,
      options: RouteRequestBody["options"],
      init?: { signal?: AbortSignal; dayNumber?: number },
    ): Promise<GeneratedPlannerRoute> {
      return routeReal(waypoints, options, init);
    },

    async getRouteQuality(
      points: ReadonlyArray<{ lat: number; lng: number }>,
      dayNumber: number,
      init?: { signal?: AbortSignal },
    ): Promise<RouteSegment[]> {
      init?.signal?.throwIfAborted();
      const cacheKey = routeQualityCacheKey(points);
      const cached = routeQualityCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        // Refresh insertion order so the cap behaves as a tiny LRU.
        routeQualityCache.delete(cacheKey);
        routeQualityCache.set(cacheKey, cached);
        return mapRouteQualitySpans(points, cached.spans, dayNumber);
      }
      if (cached) routeQualityCache.delete(cacheKey);

      const requestInit =
        init?.signal !== undefined ? { signal: init.signal } : {};
      // The backend rejects a single request over its route-length limit; a
      // long day is chunked under that and each chunk's fractions are remapped
      // back onto the whole route before mapping — so long-but-covered routes
      // still get real quality instead of a swallowed 400.
      const chunks = chunkRouteByLengthKm(
        points,
        MAX_ROUTE_QUALITY_REQUEST_KM,
        MAX_ROUTE_QUALITY_REQUEST_POINTS,
      );
      const spans: RouteQualitySegment[] = [];
      for (const chunk of chunks) {
        const { data } = await roadsApi.getRouteQuality(
          { geometry: chunk.points },
          requestInit,
        );
        for (const span of data.segments) {
          spans.push({
            ...span,
            start_fraction:
              chunk.startFraction + span.start_fraction * chunk.fractionSpan,
            end_fraction:
              chunk.startFraction + span.end_fraction * chunk.fractionSpan,
          });
        }
      }
      routeQualityCache.set(cacheKey, {
        expiresAt: Date.now() + ROUTE_QUALITY_CACHE_TTL_MS,
        spans,
      });
      while (routeQualityCache.size > MAX_ROUTE_QUALITY_CACHE_ENTRIES) {
        const oldestKey = routeQualityCache.keys().next().value as
          string | undefined;
        if (oldestKey === undefined) break;
        routeQualityCache.delete(oldestKey);
      }
      return mapRouteQualitySpans(points, spans, dayNumber);
    },

    async draftRoute(
      start: { lat: number; lng: number },
      finish: { lat: number; lng: number },
      opts: DraftOptions,
      init?: { signal?: AbortSignal },
    ): Promise<DraftRouteResult> {
      const target = opts.dailyKmForSizing;
      // The DIRECT route decides the branch (revision 2 §E cases 2/3).
      const direct = await routeReal([start, finish], opts.prefs, init);

      let zones: DraftZone[] = [];
      try {
        zones = await fetchFunZonesInBbox(
          opts.region ?? corridorBbox(start, finish),
          init,
        );
      } catch {
        // No zones ≠ no draft: the direct route is still the honest answer;
        // reachedTargetKm reports whether it covers the day on its own.
      }

      if (direct.raw.distance_km >= target) {
        // Case 3 — a full day already: never inflate. Thread only zones
        // sitting on the corridor, as flavor.
        const flavorZones = zonesNearCorridor(
          zones,
          start,
          finish,
          DRAFT_CORRIDOR_FLAVOR_KM,
        );
        const vias = draftViasThroughZones(flavorZones, start, finish, 2);
        const flavored =
          vias.length > 0
            ? await routeReal([start, ...vias, finish], opts.prefs, init)
            : direct;
        return {
          segments: flavored.segments,
          summary: flavored.summary,
          inflated: false,
          reachedTargetKm: true,
          vias,
        };
      }

      // Case 2 — INFLATE: stretch toward the target with genuinely good
      // roads only (Fun Zones), best-scoring first, measuring after each
      // addition. Stop at the target, when candidates run out, or when a
      // detour would balloon the day past the overshoot ceiling.
      const candidates = zones
        .slice()
        .sort((a, b) => b.composite_score - a.composite_score)
        .slice(0, DRAFT_CANDIDATE_LIMIT);
      let chosenZones: DraftZone[] = [];
      let vias: DraftRouteResult["vias"] = [];
      let best = direct;
      for (const zone of candidates) {
        if (chosenZones.length >= MAX_DRAFT_VIAS) break;
        const tryZones = [...chosenZones, zone];
        const tryVias = draftViasThroughZones(
          tryZones,
          start,
          finish,
          MAX_DRAFT_VIAS,
        );
        if (tryVias.length === vias.length) continue; // unusable boundary
        const measured = await routeReal(
          [start, ...tryVias, finish],
          opts.prefs,
          init,
        );
        const km = measured.raw.distance_km;
        if (
          km > target * DRAFT_MAX_OVERSHOOT &&
          Math.abs(km - target) >= Math.abs(best.raw.distance_km - target)
        ) {
          continue; // this detour overshoots without getting closer — skip it
        }
        chosenZones = tryZones;
        vias = tryVias;
        best = measured;
        if (best.raw.distance_km >= target) break;
      }
      return {
        segments: best.segments,
        summary: best.summary,
        inflated: vias.length > 0,
        reachedTargetKm:
          best.raw.distance_km >= target * DRAFT_TARGET_TOLERANCE,
        vias,
      };
    },

    // Road Preview card quality payload — built entirely from the real
    // `/roads/route-quality` overlay already on the segment (#862), so it
    // resolves immediately. Street-level imagery is a SEPARATE call
    // (`getSegmentImagery`) so a slow Mapillary lookup never blocks the
    // actionable quality/reroute card (#863).
    getRoadPreview(segment: RouteSegment): Promise<RoadPreview> {
      const hasData = segment.band !== "no_data" && segment.score != null;
      if (!hasData) {
        return Promise.resolve({
          segmentId: segment.id,
          hasData: false,
          surface: segment.surface,
          passes: segment.passes,
          // Real OSM surface tag (from the route-quality overlay), shown as the
          // unverified fallback where there are no measured passes.
          osmSurfaceTag: segment.surface,
        });
      }
      return Promise.resolve({
        segmentId: segment.id,
        hasData: true,
        ...(segment.score != null ? { score: segment.score } : {}),
        band: segment.band,
        surface: segment.surface,
        passes: segment.passes,
        ...(segment.microStrip ? { microStrip: segment.microStrip } : {}),
      });
    },

    // Street-level imagery, fetched separately from the quality card so it can
    // stream in without blocking it (#863). Best-effort → null on error / no
    // coverage. Returns the RoadPreview image fields for a shallow merge.
    async getSegmentImagery(segment: RouteSegment) {
      const imagery = await fetchSegmentImagery(segment).catch(() => null);
      if (!imagery) return null;
      return {
        imageUrl: imagery.imageUrl,
        ...(imagery.capturedAt ? { imageCapturedAt: imagery.capturedAt } : {}),
        ...(imagery.attribution
          ? { imageAttribution: imagery.attribution }
          : {}),
        ...(imagery.link ? { imageLink: imagery.link } : {}),
      };
    },

    getPois(
      route: ReadonlyArray<{ lat: number; lng: number }>,
      types: PlannerPoiType[],
      init?: { signal?: AbortSignal },
    ): Promise<PlannerPoi[]> {
      return fetchPois(route, types, init);
    },

    getPoisByCategories(bbox, categories, forMonth, init) {
      return fetchCategoryPois(bbox, categories, forMonth, init);
    },

    getRouteStops(
      routeGeometry,
      categories,
      corridorKm,
      minStayRating,
      forMonth,
      init,
    ) {
      return fetchCorridorStops(
        routeGeometry,
        categories,
        corridorKm,
        minStayRating,
        forMonth,
        init,
      );
    },

    async geocode(
      query: string,
      init?: { signal?: AbortSignal },
    ): Promise<GeoResult[]> {
      const q = query.trim();
      if (q.length < 2) return [];
      const { data, error } = await api.GET("/api/v1/geocode", {
        params: { query: { q } },
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      if (error || !data) return [];
      return data.results.map((r) => ({
        name: r.label,
        lat: r.lat,
        lng: r.lng,
      }));
    },

    async reverseGeocode(
      lat: number,
      lng: number,
      init?: {
        signal?: AbortSignal;
        format?: Pick<Formatters, "decimal">;
      },
    ): Promise<string> {
      const { data, error } = await api.GET("/api/v1/geocode/reverse", {
        params: { query: { lat, lng } },
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      // Unnamed point (e.g. open sea) or a soft API error: show the
      // coordinates rather than a blank name. Hard network/abort errors
      // reject and are left to the caller — both pin-naming call sites
      // already keep their default label on failure.
      if (error || !data?.label) return coordinateLabel(lat, lng, init?.format);
      return data.label;
    },

    async draftRoundtrip(
      start: { lat: number; lng: number },
      opts: RoundtripOptions,
      init?: { signal?: AbortSignal },
    ): Promise<DraftRoundtripResult> {
      const target = Math.max(20, opts.distanceKm);
      const bearingDeg =
        opts.direction === "random"
          ? Math.random() * 360
          : ROUNDTRIP_BEARING_DEG[opts.direction];
      const routeOptions: RouteRequestBody["options"] = {
        // Sidebar constraints (avoid flags etc.) apply to the measuring
        // routes exactly as they will to the live reroute (§E).
        ...opts.prefs,
        // The loop's road character routes like its point-to-point
        // equivalent; 'efficient_loop' costs like 'direct'.
        preference:
          opts.preference === "efficient_loop" ? "direct" : opts.preference,
      };

      let radiusKm = target / (2 * ROUNDTRIP_ROAD_FACTOR);
      let turn = offsetPointKm(start, bearingDeg, radiusKm);

      // Fun Zones in the loop's lobe (drawn region wins when present).
      let zones: DraftZone[] = [];
      try {
        zones = await fetchFunZonesInBbox(
          opts.region ?? corridorBbox(start, turn),
          init,
        );
      } catch {
        // No zones ≠ no loop — the geometric turnaround still rides.
      }
      const zoneVias = draftViasThroughZones(zones, start, turn, 2);

      const loopWaypoints = () => [
        start,
        ...zoneVias.map(({ lat, lng }) => ({ lat, lng })),
        turn,
        start,
      ];
      let measured = await routeReal(loopWaypoints(), routeOptions, init);

      // One sizing iteration: scale the turnaround radius toward the soft
      // target. Skipped when zone vias anchor the shape — stretching past
      // the good roads would defeat the point of threading them.
      const firstKm = measured.raw.distance_km;
      if (
        zoneVias.length === 0 &&
        firstKm > 0 &&
        Math.abs(firstKm - target) / target > 0.15
      ) {
        const scale = Math.min(2.5, Math.max(0.4, target / firstKm));
        radiusKm *= scale;
        turn = offsetPointKm(start, bearingDeg, radiusKm);
        measured = await routeReal(loopWaypoints(), routeOptions, init);
      }

      return {
        segments: measured.segments,
        summary: measured.summary,
        reachedTargetKm:
          measured.raw.distance_km >= target * DRAFT_TARGET_TOLERANCE,
        // The turnaround is a semantic via, not English rider data. Leaving
        // its name absent lets the display layer localize the role (and the
        // planner may replace it with a reverse-geocoded place name).
        vias: [...zoneVias, { lat: turn.lat, lng: turn.lng }],
      };
    },

    async getUserRoutePrefs(init?: {
      signal?: AbortSignal;
    }): Promise<UserRoutePrefs | null> {
      const { data } = await usersApi.getMe(
        init?.signal !== undefined ? { signal: init.signal } : {},
      );
      const wire = (
        data.preferences as { route_prefs?: UserRoutePrefsWire } | undefined
      )?.route_prefs;
      return wire ? routePrefsFromWire(wire) : null;
    },

    async saveUserRoutePrefs(prefs: UserRoutePrefs): Promise<void> {
      await usersApi.updateMe({
        preferences: { route_prefs: routePrefsToWire(prefs) },
      });
    },
  };
}

// ── Roundtrip drafting helpers (revision 3 §E) ───────────────────────

/** Loop length ≈ 2 × crow-flies radius × this road-shape factor. */
const ROUNDTRIP_ROAD_FACTOR = 1.4;

const ROUNDTRIP_BEARING_DEG: Record<
  Exclude<RoundtripOptions["direction"], "random">,
  number
> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

const KM_PER_DEG_LAT = 111.32;

function offsetPointKm(
  origin: { lat: number; lng: number },
  bearingDeg: number,
  distanceKm: number,
): { lat: number; lng: number } {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceKm * Math.cos(bearingRad)) / KM_PER_DEG_LAT;
  const dLng =
    (distanceKm * Math.sin(bearingRad)) /
    (KM_PER_DEG_LAT * Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180)));
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

// ── Saved planner defaults, users.preferences JSONB wire mapping (§F) ─

function routePrefsFromWire(wire: UserRoutePrefsWire): UserRoutePrefs {
  return {
    roadPreference: wire.road_preference,
    avoidHighways: wire.avoid_highways,
    avoidTolls: wire.avoid_tolls,
    avoidUnpaved: wire.avoid_unpaved,
    surfaces: wire.surfaces.filter(
      (surface): surface is (typeof SURFACE_VALUES)[number] =>
        (SURFACE_VALUES as readonly string[]).includes(surface),
    ),
    minQuality: wire.min_quality,
  };
}

function routePrefsToWire(prefs: UserRoutePrefs): UserRoutePrefsWire {
  return {
    road_preference: prefs.roadPreference,
    avoid_highways: prefs.avoidHighways,
    avoid_tolls: prefs.avoidTolls,
    avoid_unpaved: prefs.avoidUnpaved,
    surfaces: prefs.surfaces,
    min_quality: prefs.minQuality,
  };
}

export const plannerApi: PlannerApi = createPlannerApi();
