import { haversineKm, SURFACE_TYPES, type SurfaceType } from "@tarmoto/shared";
import {
  poiApi,
  roadsApi,
  routingApi,
  usersApi,
  type AccommodationSuggestion,
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
import { fetchFunZonesInBbox } from "@/lib/discover";
import { deriveQualitySegments } from "./derive";
import { mapRouteQualitySpans } from "./route-quality";
import {
  corridorBbox,
  draftViasThroughZones,
  zonesNearCorridor,
  MAX_DRAFT_VIAS,
  type DraftZone,
} from "./draft-vias";
import {
  mockGeocode,
  mockPoisByCategories,
  mockReverseGeocode,
  mockRoadPreview,
  mockRouteStops,
} from "./mocks";
import { SURFACE_VALUES, type UserRoutePrefs } from "./prefs";
import type {
  DraftOptions,
  DraftRouteResult,
  DraftRoundtripResult,
  FlaggedSection,
  GeneratedPlannerRoute,
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
import { QUALITY_BAND_LABELS_SHORT } from "./quality-bands";

/**
 * The planner's single data seam. Real sources: backend Valhalla routing
 * (`routingApi`), the `/poi/*` endpoints, and per-segment surface quality
 * (`roadsApi.getRouteQuality`, mapped in `./route-quality`). Mock sources
 * (see `./mocks/`): road previews and geocoding. Swapping a mock for its real
 * source only ever touches this file.
 */

const SURFACE_TYPE_SET: ReadonlySet<string> = new Set(SURFACE_TYPES);

function asSurfaceType(key: string): SurfaceType {
  return SURFACE_TYPE_SET.has(key) ? (key as SurfaceType) : "unknown";
}

// The backend rejects a single /route-quality request over its route-length
// limit (MAX_ROUTE_QUALITY_LENGTH_M = 500 km, roads.service.ts); keep each
// request safely under it.
const MAX_ROUTE_QUALITY_REQUEST_KM = 480;

interface RouteChunk {
  points: { lat: number; lng: number }[];
  /** Where this chunk starts on the whole route, as a fraction [0,1]. */
  startFraction: number;
  /** This chunk's share of the whole route length, as a fraction. */
  fractionSpan: number;
}

/**
 * Split a routed polyline into contiguous chunks each at most `maxKm` long, so
 * a long day stays under the backend's per-request length limit. Chunks share
 * their boundary vertex (gap-free) and record where they sit on the whole route
 * so per-chunk quality fractions can be remapped back onto it.
 */
function chunkRouteByLengthKm(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  maxKm: number,
): RouteChunk[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    cum.push((cum[i - 1] ?? 0) + haversineKm(a.lat, a.lng, b.lat, b.lng));
  }
  const total = cum[cum.length - 1] ?? 0;
  if (points.length < 2 || total <= maxKm) {
    return [
      {
        points: points.map((p) => ({ ...p })),
        startFraction: 0,
        fractionSpan: total > 0 ? 1 : 0,
      },
    ];
  }
  const chunks: RouteChunk[] = [];
  let startIdx = 0;
  while (startIdx < points.length - 1) {
    const startKm = cum[startIdx] ?? 0;
    let endIdx = startIdx + 1;
    while (
      endIdx + 1 <= points.length - 1 &&
      (cum[endIdx + 1] ?? 0) - startKm <= maxKm
    ) {
      endIdx += 1;
    }
    const endKm = cum[endIdx] ?? 0;
    chunks.push({
      points: points.slice(startIdx, endIdx + 1).map((p) => ({ ...p })),
      startFraction: total > 0 ? startKm / total : 0,
      fractionSpan: total > 0 ? (endKm - startKm) / total : 0,
    });
    if (endIdx >= points.length - 1) break;
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
  return [...metresBySurface.entries()]
    .map(([surface, metres]) => ({
      surface,
      pct: Math.round((metres / total) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
}

export function deriveFlaggedSections(
  segments: readonly RouteSegment[],
): FlaggedSection[] {
  const flagged: FlaggedSection[] = [];
  for (const segment of segments) {
    const lengthKm = Math.round(segment.lengthKm * 10) / 10;
    if (segment.band === "rough") {
      flagged.push({
        segmentId: segment.id,
        kind: "rough",
        lengthKm,
        label: `${QUALITY_BAND_LABELS_SHORT.rough} · ${segment.surface}, ${lengthKm} km`,
      });
    } else if (segment.band === "no_data") {
      flagged.push({
        segmentId: segment.id,
        kind: "no_data",
        lengthKm,
        label: `No data yet · ${lengthKm} km`,
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
    name: poi.name ?? "Unnamed",
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
    name: stay.name ?? "Unnamed",
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
    source: "osm",
    name: poi.name ?? "Unnamed",
    lat: poi.lat,
    lng: poi.lng,
    meta: {
      stars: poi.stars,
      website: poi.website,
      phone: poi.phone,
      openingHours: poi.opening_hours,
      addressCity: poi.address_city,
      cuisine: poi.cuisine,
      brand: poi.brand,
      osmUrl: poi.osm_url,
      mapsUrl: poi.maps_url,
    },
  };
}

async function fetchCategoryPois(
  bbox: [number, number, number, number],
  categories: PoiCategory[],
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
    // mountain_pass / twisty_highlight aren't OSM — keep the mock source until
    // the passes API + curviness layer are wired (#849 follow-up).
    nonStoreCategories.length > 0
      ? Promise.resolve(mockPoisByCategories(bbox, nonStoreCategories))
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
    // mountain_pass / twisty_highlight aren't in the store — mock source.
    nonStoreCategories.length > 0
      ? Promise.resolve(
          mockRouteStops(
            routeGeometry,
            nonStoreCategories,
            corridorKm,
            minStayRating,
          ),
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

export function createPlannerApi(): PlannerApi {
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
      const requestInit =
        init?.signal !== undefined ? { signal: init.signal } : {};
      // The backend rejects a single request over its route-length limit; a
      // long day is chunked under that and each chunk's fractions are remapped
      // back onto the whole route before mapping — so long-but-covered routes
      // still get real quality instead of a swallowed 400.
      const chunks = chunkRouteByLengthKm(points, MAX_ROUTE_QUALITY_REQUEST_KM);
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

    getRoadPreview(segment: RouteSegment): Promise<RoadPreview> {
      return Promise.resolve(mockRoadPreview(segment));
    },

    getPois(
      route: ReadonlyArray<{ lat: number; lng: number }>,
      types: PlannerPoiType[],
      init?: { signal?: AbortSignal },
    ): Promise<PlannerPoi[]> {
      return fetchPois(route, types, init);
    },

    getPoisByCategories(bbox, categories, init) {
      return fetchCategoryPois(bbox, categories, init);
    },

    getRouteStops(routeGeometry, categories, corridorKm, minStayRating, init) {
      return fetchCorridorStops(
        routeGeometry,
        categories,
        corridorKm,
        minStayRating,
        init,
      );
    },

    geocode(query: string) {
      return Promise.resolve(mockGeocode(query));
    },

    reverseGeocode(lat: number, lng: number) {
      return Promise.resolve(mockReverseGeocode(lat, lng));
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
        vias: [
          ...zoneVias,
          { lat: turn.lat, lng: turn.lng, name: "Turnaround" },
        ],
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
