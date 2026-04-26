import type {
  SurfaceType,
  Trip,
  TripDay,
  TripParameters,
  Waypoint,
} from "@/lib/types";

/**
 * Backend `TripDetailDto` shape (from `apps/backend/.../trip-response.dto.ts`).
 * Re-declared here so the companion isn't forced to depend on the backend
 * package directly while the OpenAPI generation rolls.
 *
 * Field names are snake_case to match what the backend serialises.
 */
export interface TripDetailResponse {
  id: string;
  title: string;
  region: string | null;
  num_days: number;
  status: string;
  member_count: number;
  created_at: string;
  daily_km_min: number;
  daily_km_max: number;
  min_quality: number;
  road_preference: string;
  invite_code: string;
  members: TripDetailMember[];
  days: TripDetailDay[];
}

export interface TripDetailMember {
  user_id: string;
  display_name: string;
  role: string; // 'owner' | 'admin' | 'member'
  joined_at: string;
}

export interface TripDetailDay {
  id: string;
  day_number: number;
  title: string | null;
  distance_km: number;
  avg_quality: number;
  elevation_gain: number;
  elevation_loss: number;
  curviness_score: number;
  scenic_score: number;
  estimated_time_min: number;
  route_geometry: Array<{ lat: number; lng: number }>;
  waypoints: TripDetailWaypoint[];
}

export interface TripDetailWaypoint {
  id: string;
  sequence: number;
  lat: number;
  lng: number;
  name: string | null;
  waypoint_type: string;
  road_segment_id: string | null;
  notes: string | null;
  duration_min: number | null;
}

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
 * `TripExportMenu`, `TripStopsPanel`, etc.) can render server-loaded trips
 * without each component growing a snake_case branch.
 *
 * The mapping is intentionally lossy: the local `Trip` doesn't carry
 * elevation_loss, scenic_score, or per-day estimated_time_min separately
 * from the rolled-up planner stats. Anything the planner UI doesn't read
 * is dropped on purpose so the type stays the single source of truth.
 */
export function tripFromDetail(detail: TripDetailResponse): Trip {
  const days: TripDay[] = (detail.days ?? []).map((day) => mapDay(day));

  return {
    id: detail.id,
    name: detail.title,
    status: VALID_TRIP_STATUSES.has(detail.status as Trip["status"])
      ? (detail.status as Trip["status"])
      : "draft",
    days,
    parameters: parametersFromDetail(detail),
    collaborators: (detail.members ?? []).map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      role: mapMemberRoleToCollaboratorRole(m.role),
    })),
    createdAt: detail.created_at,
    // Backend doesn't return updated_at on the detail DTO. Fall back to
    // created_at so callers ordering by recency don't crash.
    updatedAt: detail.created_at,
  };
}

/** Pick the owner's user id, or null if the trip has no owner row. */
export function findOwnerId(detail: TripDetailResponse): string | null {
  return detail.members?.find((m) => m.role === "owner")?.user_id ?? null;
}

function mapDay(day: TripDetailDay): TripDay {
  const waypoints: Waypoint[] = [...(day.waypoints ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((w) => ({
      id: w.id,
      name: w.name ?? undefined,
      location: { lat: w.lat, lng: w.lng },
      type: WAYPOINT_TYPE_MAP[w.waypoint_type] ?? "via",
    }));

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
  };
}

function parametersFromDetail(detail: TripDetailResponse): TripParameters {
  const min = detail.daily_km_min ?? 150;
  const max = detail.daily_km_max ?? 350;
  return {
    days: detail.num_days || detail.days?.length || 1,
    // Planner UI exposes a single km/day target; pick the midpoint of the
    // persisted [min, max] band so re-entering the planner shows a sane
    // default the rider can adjust.
    dailyKmTarget: Math.round((min + max) / 2),
    roadPreference: VALID_ROAD_PREFERENCES.has(
      detail.road_preference as TripParameters["roadPreference"],
    )
      ? (detail.road_preference as TripParameters["roadPreference"])
      : "mixed",
    // The backend doesn't persist the surface filter or avoidance flags
    // yet; default to the planner's initial values so the UI loads in a
    // consistent state. Once the backend grows these columns this should
    // be replaced with the persisted values.
    surfacePreference: ["asphalt"] as SurfaceType[],
    avoidHighways: true,
    avoidTolls: false,
    avoidUnpaved: true,
    minQuality: detail.min_quality ?? 3,
  };
}

function mapMemberRoleToCollaboratorRole(
  role: string,
): "owner" | "editor" | "viewer" {
  if (role === "owner") return "owner";
  if (role === "admin") return "editor";
  return "viewer";
}
