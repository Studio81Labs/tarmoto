import type { components } from "@tarmoto/openapi-client";
import type {
  POI,
  SurfaceType,
  Trip,
  TripDay,
  TripParameters,
  Waypoint,
} from "@/lib/types";

// Backend trip contract — the generated `TripDetailDto` and its member / day /
// waypoint shapes. `tripFromDetail` adapts this snake_case wire into the
// companion's camelCase `Trip` view model below. The adapter's helpers take
// loose `string`s + validate, so they tolerate the stricter generated unions.
export type TripDetailResponse = components["schemas"]["TripDetailDto"];
export type TripDetailMember = components["schemas"]["TripMemberDto"];
export type TripDetailDay = components["schemas"]["TripDayDto"];
export type TripDetailWaypoint = components["schemas"]["TripWaypointDto"];

/**
 * Route inputs that are deliberately request-scoped rather than persisted on
 * the shared Trip record. A REST response or collaboration broadcast therefore
 * cannot rehydrate them and must retain the current rider's local choices.
 */
export type RequestOnlyRouteOptions = Pick<
  TripParameters,
  "surfacePreference" | "avoidHighways" | "avoidTolls" | "avoidUnpaved"
>;

const VALID_ROAD_PREFERENCES: ReadonlySet<TripParameters["roadPreference"]> =
  new Set(["curvy", "scenic", "mixed", "direct"]);

const VALID_TRIP_STATUSES: ReadonlySet<Trip["status"]> = new Set([
  "draft",
  "planned",
  "active",
  "completed",
]);

// Backend exposes a richer waypoint_type vocabulary than the local Trip
// model. Coffee/food collapse onto "rest" and hotel onto "accommodation"
// because that's how the planner UI renders them; round-tripping through
// `tripToBackendUpdate` would need a dedicated reverse map.
const WAYPOINT_TYPE_MAP: Record<string, Waypoint["type"]> = {
  start: "start",
  via: "via",
  end: "end",
  fuel: "fuel",
  food: "rest",
  coffee: "rest",
  hotel: "accommodation",
  photo: "photo",
};

/**
 * Convert a backend `TripDetailDto` into the companion's local `Trip`
 * shape so existing planner components (`TripPlannerMap`, `SegmentSidebar`,
 * `TripExportButton`, `TripStopsPanel`, etc.) can render server-loaded trips
 * without each component growing a snake_case branch.
 *
 * The mapping is intentionally lossy: the local `Trip` doesn't carry
 * elevation_loss, scenic_score, or per-day estimated_time_min separately
 * from the rolled-up planner stats. Anything the planner UI doesn't read
 * is dropped on purpose so the type stays the single source of truth.
 */
/**
 * Wire shape for `GET /api/v1/trips` list rows — the generated `TripSummaryDto`
 * plus two forward-compat fields (#647) the backend ships incrementally that
 * aren't in the DTO yet; both optional so they flow through when present.
 * `tripSummaryFromWire` adapts snake_case → the companion's camelCase.
 */
export type TripSummaryWire = components["schemas"]["TripSummaryDto"] & {
  updated_at?: string;
  warnings_count?: number;
};

/**
 * Adapt a wire `TripSummaryDto` row into the companion's
 * `TripSummary` shape. Mirrors how `tripFromDetail` adapts the
 * detail endpoint: name/createdAt are translated from the wire
 * snake_case so the rest of the app keeps a single style. Without
 * this, list consumers read `trip.name` / `trip.createdAt` and get
 * `undefined` — cards render blank, sort-by-created breaks.
 */
export function tripSummaryFromWire(
  wire: TripSummaryWire,
): import("@/lib/types").TripSummary {
  return {
    id: wire.id,
    name: wire.title,
    status: wire.status,
    num_days: wire.num_days,
    member_count: wire.member_count,
    region: wire.region,
    owner_id: wire.owner_id,
    folder_id: wire.folder_id,
    createdAt: wire.created_at,
    // #647 follow-up fields — pass through so the trip-list card meta
    // strip lights up as soon as backend starts surfacing them on
    // `TripSummaryDto`. Skipping these here is what would silently
    // strip the new metadata before it reached the card.
    updatedAt: wire.updated_at,
    distance_km: wire.distance_km ?? null,
    quality_avg: wire.quality_avg ?? null,
    passes_count: wire.passes_count ?? null,
    warnings_count: wire.warnings_count,
    overviewGeometry: wire.overview_geometry ?? null,
  };
}

export function tripFromDetail(detail: TripDetailResponse): Trip {
  const days: TripDay[] = (detail.days ?? []).map((day, i, arr) =>
    mapDay(day, i === arr.length - 1),
  );

  return {
    id: detail.id,
    name: detail.title,
    status: VALID_TRIP_STATUSES.has(detail.status as Trip["status"])
      ? (detail.status as Trip["status"])
      : "draft",
    // `num_days` and `member_count` are required (or optional but
    // inherited) on `TripSummary`. Backend's `TripDetailDto`
    // extends `TripSummaryDto` and carries both; preserve them so
    // a detail-derived row pushed into a `TripSummary[]` (e.g.
    // the duplicate-trip flow on the /trips list) reads the same
    // values a list-endpoint refetch would deliver. Without the
    // member_count copy, duplicated collaborative trips would
    // hide their rider count until the list refetches.
    num_days: detail.num_days ?? days.length,
    member_count: detail.member_count ?? (detail.members ?? []).length,
    days,
    parameters: parametersFromDetail(detail),
    collaborators: (detail.members ?? []).map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      role: mapMemberRoleToCollaboratorRole(m.role),
    })),
    // Summary-side fields carried through so list-view consumers
    // (folder scoping, owner-aware UI) get the same shape as the
    // list endpoint after going through this adapter. Both are
    // optional on `Trip` and `TripDetailResponse`, so detail-only
    // callers (planner) keep getting `undefined`.
    owner_id: detail.owner_id,
    folder_id: detail.folder_id ?? null,
    createdAt: detail.created_at,
    // Backend doesn't return updated_at on the detail DTO. Fall back to
    // created_at so callers ordering by recency don't crash.
    updatedAt: detail.created_at,
    // #647 rollups served on the detail DTO too — pass through so a
    // detail-derived list row (duplicate-trip flow) carries the same card
    // metadata as a list-endpoint row instead of blanks until refetch.
    distance_km: detail.distance_km ?? null,
    quality_avg: detail.quality_avg ?? null,
    passes_count: detail.passes_count ?? null,
    // Carry the route outline too, so a detail-derived card (duplicate-trip
    // flow) renders the real RouteOutlineSvg immediately instead of falling
    // back to the abstract sketch until the list refetches.
    overviewGeometry: detail.overview_geometry ?? null,
  };
}

/**
 * Restore request-only routing inputs after adapting a TripDetailDto.
 *
 * The backend intentionally omits these fields from TripDetailDto because
 * collaborators may experiment with their own filters without changing the
 * shared trip metadata. Without this merge, a save response (and its
 * `trip:updated` echo) replaces the rider's selections with adapter defaults.
 */
export function withRequestOnlyRouteOptions(
  trip: Trip,
  options: RequestOnlyRouteOptions,
): Trip {
  return {
    ...trip,
    parameters: {
      ...trip.parameters,
      surfacePreference: [...options.surfacePreference],
      avoidHighways: options.avoidHighways,
      avoidTolls: options.avoidTolls,
      avoidUnpaved: options.avoidUnpaved,
    },
  };
}

/** Pick the owner's user id, or null if the trip has no owner row. */
export function findOwnerId(detail: TripDetailResponse): string | null {
  return detail.members?.find((m) => m.role === "owner")?.user_id ?? null;
}

function mapDay(day: TripDetailDay, isFinalDay: boolean): TripDay {
  const sortedSourceWaypoints = [...(day.waypoints ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const waypoints: Waypoint[] = sortedSourceWaypoints.map((w) => ({
    id: w.id,
    name: w.name ?? undefined,
    location: { lat: w.lat, lng: w.lng },
    type: WAYPOINT_TYPE_MAP[w.waypoint_type] ?? "via",
    ...(w.poi_category ? { poiCategory: w.poi_category } : {}),
  }));

  // Surface the day's overnight stop as a `POI` so the detail page's
  // day-by-day card can show "Overnight: …" without re-scanning every
  // waypoint. The backend trip generator ends each non-final day with a
  // `hotel` waypoint, and a day shouldn't realistically have more than
  // one — but if a planner adds extras, the latest by sequence wins so
  // we surface the actual end-of-day stay instead of an early stopover.
  //
  // After a manual save, the planner normalizes a terminal stay to a routed
  // `end` (the backend save path requires an explicit end), so a re-saved
  // generated/overnight leg no longer carries a `hotel`. For a NON-FINAL day,
  // fall back to the day's `end` — on a multi-day trip that endpoint IS the
  // overnight boundary. The final day's `end` is the trip finish, not a stay.
  const lastHotel = [...sortedSourceWaypoints]
    .reverse()
    .find((w) => w.waypoint_type === "hotel");
  const overnightSource =
    lastHotel ??
    (isFinalDay
      ? undefined
      : sortedSourceWaypoints.find((w) => w.waypoint_type === "end"));
  const overnightStop: POI | undefined = overnightSource
    ? {
        id: overnightSource.id,
        name: overnightSource.name?.trim() ?? "",
        type: "accommodation",
        ...(overnightSource.poi_category
          ? { poiCategory: overnightSource.poi_category }
          : {}),
        location: { lat: overnightSource.lat, lng: overnightSource.lng },
      }
    : undefined;

  const routeGeometry = day.route_geometry?.length
    ? {
        type: "LineString" as const,
        // GeoJSON uses [lng, lat] tuples; the backend serialises objects.
        coordinates: day.route_geometry.map(
          (p) => [p.lng, p.lat] as [number, number],
        ),
      }
    : undefined;

  return {
    dayNumber: day.day_number,
    title: day.title ?? undefined,
    waypoints,
    routeGeometry,
    distanceKm: day.distance_km ?? 0,
    durationMinutes: day.estimated_time_min ?? 0,
    elevationGain: day.elevation_gain ?? 0,
    avgQuality: day.avg_quality ?? 0,
    overnightStop,
    startLinked: day.start_linked ?? false,
    legPreferences:
      (day.leg_preferences as TripDay["legPreferences"] | undefined) ?? null,
  };
}

function parametersFromDetail(detail: TripDetailResponse): TripParameters {
  const min = detail.daily_km_min ?? 150;
  const max = detail.daily_km_max ?? 350;
  // Use `??` so an explicit `0` from the server doesn't silently fall
  // through to `days.length`, then floor at 1 because a planner with
  // zero days is a degenerate UI we never want to render — the slider
  // and timeline both assume `days >= 1`.
  const persistedDays = detail.num_days ?? detail.days?.length ?? 0;
  return {
    days: Math.max(1, persistedDays),
    // Planner UI exposes a single km/day target; pick the midpoint of the
    // persisted [min, max] band so re-entering the planner shows a sane
    // default the rider can adjust.
    dailyKmTarget: Math.round((min + max) / 2),
    roadPreference: mapRoadPreference(detail.road_preference),
    // Surface and avoidance inputs are request-scoped rather than shared trip
    // metadata. New hydration defaults consistently; planner mutations merge
    // the current rider's choices back with `withRequestOnlyRouteOptions`.
    surfacePreference: ["asphalt"] as SurfaceType[],
    avoidHighways: true,
    avoidTolls: false,
    avoidUnpaved: true,
    minQuality: detail.min_quality ?? 3,
  };
}

function mapRoadPreference(value: string): TripParameters["roadPreference"] {
  if (value === "fast") return "direct";
  return VALID_ROAD_PREFERENCES.has(value as TripParameters["roadPreference"])
    ? (value as TripParameters["roadPreference"])
    : "mixed";
}

function mapMemberRoleToCollaboratorRole(
  role: string,
): "owner" | "editor" | "viewer" {
  if (role === "owner") return "owner";
  // 'admin' is the pre-1793 name for 'editor'; accept both.
  if (role === "editor" || role === "admin") return "editor";
  return "viewer";
}
