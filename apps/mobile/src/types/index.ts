/**
 * Tarmoto Core Types
 * Mirrors the OpenAPI schema — keep in sync with backend DTOs.
 *
 * Generated `components["schemas"]` from `@tarmoto/openapi-client` are re-exported
 * below so screen-level consumers can refer to the spec-derived shapes
 * without reaching into the openapi-typescript output directly. Drift in a
 * backend DTO that matters to a screen propagates through these aliases
 * and surfaces at the call site, not just at the `services/api.ts`
 * boundary (#354 / source PR #330).
 */

// Canonical wire shape for the public rider profile (US-27 / convergence
// US-345). Re-exported from `@tarmoto/shared` so backend, mobile, and
// companion all consume the same definition; a field added there propagates
// here automatically and the backend DTO `implements PublicProfile`
// guarantees the wire format stays in lock-step.
export type { PublicProfile } from "@tarmoto/shared";

// Rider progression (XP / level / tier) for the achievements screen. Same
// rationale as PublicProfile — re-exported from `@tarmoto/shared` so the
// backend `ProgressionDto implements RiderProgression` keeps the wire shape
// aligned across backend, mobile, and companion.
export type { RiderProgression } from "@tarmoto/shared";

// Authenticated rider's own profile summary (issue #334). Re-exported from
// `@tarmoto/shared` so backend, mobile, and companion share one definition.
export type { MeProfile } from "@tarmoto/shared";

// Tier-aware feature entitlements. The registry and resolution live in
// `@tarmoto/shared` (`FEATURE_DEFINITIONS` / `resolveFeature`); the resolved
// snapshot rides on `/users/me` and the auth responses as `user.features`.
export type { FeatureKey, FeatureSnapshot } from "@tarmoto/shared";

// Domain enums (surface / ride / hazard / waypoint types + hazard severity)
// are the canonical `@tarmoto/shared` definitions the backend DTOs are built
// from — re-exported here rather than re-declared so mobile stays in
// lock-step with backend + companion. `Severity` keeps its historical mobile
// name, aliased to the identical shared `HazardSeverity` (`low|medium|high`).
export type {
  SurfaceType,
  RideType,
  HazardType,
  WaypointType,
} from "@tarmoto/shared";
import type { HazardSeverity, SurfaceType } from "@tarmoto/shared";
export type Severity = HazardSeverity;

// Generated OpenAPI component schemas — re-exported so screens, services,
// and stores can refer to spec-derived shapes through `@/types` instead
// of importing from `@tarmoto/openapi-client` directly. `Schemas["FooDto"]`
// reads cleaner at call sites than the underlying
// `components["schemas"]["FooDto"]`.
import type { components } from "@tarmoto/openapi-client";
export type Schemas = components["schemas"];

// ── Primitives ──

export interface LatLng {
  lat: number;
  lng: number;
}

// ── Auth ──

export type AuthResponse = Schemas["AuthResponseDto"];

// ── Users ──

/**
 * Authenticated rider — the generated `UserResponseDto`. `preferences` is the
 * spec's `UserPreferencesResponse` (every field optional, since a
 * freshly-registered rider reaches the client before toggling anything), so
 * consumers must still default with `?? <default>`.
 */
export type User = Schemas["UserResponseDto"];

/** Single row from /users/:userId/followers and /users/:userId/following. */
export type FollowerListItem = Schemas["FollowerDto"];

/**
 * #336: per-rider shared-ride card returned by
 * `GET /users/:userId/shared-rides` — the generated `UserSharedRideDto`.
 * Drives the "Shared rides" section on both own-profile and view-profile
 * screens.
 */
export type UserSharedRide = Schemas["UserSharedRideDto"];

/** Paginated `GET /users/:userId/shared-rides` response. */
export type UserSharedRidesResponse = Schemas["UserSharedRidesResponseDto"];

/**
 * US-27: badge entry as returned by /users/:userId/badges — the generated
 * `BadgeDto`. `earned_at` is optional on the wire (absent for badges that
 * carry no timestamp), so consumers must null-check it.
 */
export type UserBadge = Schemas["BadgeDto"];

export interface UserPreferences {
  units: "metric" | "imperial";
  daily_km: number;
  min_quality: number;
  road_types: string[];
  record_gps: boolean;
  crash_detection: boolean;
}

/**
 * Schema-derived alias for the ContactResponseDto wire shape. Routing
 * `EmergencyContact` through `Schemas` means a backend rename or removal
 * surfaces as a typecheck failure at the consuming screen
 * (`EmergencyContactsScreen`) instead of being absorbed by the cast on
 * the `services/api.ts` boundary.
 */
export type EmergencyContact = Schemas["ContactResponseDto"];

/** Payload for creating or editing a contact. */
export interface EmergencyContactInput {
  name: string;
  phone: string;
  is_emergency?: boolean;
}

// ── Road Segments ──

export type QualityClass = "excellent" | "good" | "fair" | "poor" | "very_poor";

/** Road segment summary from `/roads/nearby` — the generated `RoadSegmentDto`. */
export type RoadSegment = Schemas["RoadSegmentDto"];

/**
 * Full road-segment detail (`/roads/:id`) — the generated `RoadSegmentDetailDto`.
 * Its `active_hazards` / `recent_reviews` are the spec's nested DTOs, so a
 * backend change to either propagates here at typecheck time.
 */
export type RoadSegmentDetail = Schemas["RoadSegmentDetailDto"];

/** Fun-zone polygon (curviest-roads cluster) — the generated `FunZoneDto`. */
export type FunZone = Schemas["FunZoneDto"];

// ── Rides ──

/** Ride lifecycle status — the `RideSummaryDto.status` union. */
export type RideStatus = Schemas["RideSummaryDto"]["status"];

/**
 * Slim ride shape returned by `/rides/start` and `/rides/stop` — the generated
 * `RideResponseDto`. Only the columns owned by the `rides` row itself; call
 * `getRide` for the full `RideDetail`.
 */
export type RideResponse = Schemas["RideResponseDto"];

/** Ride list row (`GET /rides`) — the generated `RideSummaryDto`. */
export type RideSummary = Schemas["RideSummaryDto"];

/** Full ride detail (`GET /rides/:id`) — the generated `RideDetailDto`. */
export type RideDetail = Schemas["RideDetailDto"];

/** One snapped segment of a ride's detail — the generated `RideSegmentDto`. */
export type RideSegment = Schemas["RideSegmentDto"];

// ── Hazards ──

/** Hazard marker (`GET /hazards/nearby`, reports) — the generated `HazardResponseDto`. */
export type Hazard = Schemas["HazardResponseDto"];

/**
 * Wire shape of the `hazard:new` WebSocket event broadcast by the
 * backend `EventsGateway`. Structurally compatible with `Hazard` for
 * create/confirm broadcasts so clients can render the marker directly
 * from the event without a follow-up REST fetch.
 *
 * Dismissals reuse the same channel with `severity: "dismissed"` —
 * clients use this to prune the hazard from the local map without a
 * follow-up poll. The narrow `Severity` enum can't carry it, so the
 * wire type widens severity to a union.
 */
export type HazardAlertSeverity = Severity | "dismissed";

export interface HazardAlertEvent extends Omit<Hazard, "severity"> {
  severity: HazardAlertSeverity;
}

// ── Trips ──

export type TripStatus = Schemas["TripSummaryDto"]["status"];
export type RoadPreference = Schemas["TripDetailDto"]["road_preference"];

/** Trip list row (`GET /trips`) — the generated `TripSummaryDto`. */
export type TripSummary = Schemas["TripSummaryDto"];

// US-37 — rider-owned folder that groups trips. Re-exported from
// `@tarmoto/shared` so backend, mobile, and companion all consume the
// same definition; a field added there propagates here automatically
// and the backend DTO `implements TripFolder`-shape via the wire
// guarantees the three layers stay in lock-step.
export type { TripFolder } from "@tarmoto/shared";

/** Full trip detail (`GET /trips/:id`) — the generated `TripDetailDto`. */
export type Trip = Schemas["TripDetailDto"];

/** One day of a trip — the generated `TripDayDto`. */
export type TripDay = Schemas["TripDayDto"];

export type TripGenerationOptionId =
  Schemas["GenerateTripResponseDto"]["selected_option"];

/** One generated trip option — the generated `TripGenerationOptionDto`. */
export type TripGenerationOption = Schemas["TripGenerationOptionDto"];

/** `POST /trips/generate` response — the generated `GenerateTripResponseDto`. */
export type TripGenerationResult = Schemas["GenerateTripResponseDto"];

/** Trip waypoint — the generated `TripWaypointDto` (fields required-nullable). */
export type Waypoint = Schemas["TripWaypointDto"];

/** Trip collaborator — the generated `TripMemberDto`. */
export type TripMember = Schemas["TripMemberDto"];

// ── Reviews ──

/** Road review (`GET /roads/:id/reviews`) — the generated `ReviewResponseDto`. */
export type RoadReview = Schemas["ReviewResponseDto"];

/** Result of POST / DELETE /roads/reviews/:reviewId/vote — `ReviewVoteResultDto`. */
export type ReviewVoteResult = Schemas["ReviewVoteResultDto"];

// ── Commute ──

/** Saved commute route — the generated `CommuteRouteResponseDto`. */
export type CommuteRoute = Schemas["CommuteRouteResponseDto"];

/**
 * Commute status (#353) — the generated `CommuteStatusResponseDto`. The
 * backend composes hazards + weather inline so the rider gets one round-trip;
 * `weather` is null when the provider is briefly unreachable.
 */
export type CommuteStatus = Schemas["CommuteStatusResponseDto"];

/** Alternative commute route (`GET /commute/alternatives`) — `AlternativeRouteDto`. */
export type CommuteAlternativeRoute = Schemas["AlternativeRouteDto"];

export type CommuteAlternativesResponse =
  Schemas["CommuteAlternativesResponseDto"];

export type CommuteStatsPeriod = Schemas["CommuteStatsPeriodDto"];

export type CommuteStatsDailyBreakdown = Schemas["DailyBreakdownDto"];

/** Commute stats (US-24) — the generated `CommuteStatsResponseDto`. */
export type CommuteStats = Schemas["CommuteStatsResponseDto"];

// ── Weather ──

/** Weather conditions at a point — the generated `WeatherResponseDto`. */
export type Weather = Schemas["WeatherResponseDto"];

/** Weather sampled at a route point — the generated `RouteWeatherPointDto`. */
export type RouteWeatherPoint = Schemas["RouteWeatherPointDto"];

export type WeatherAlertKind = Schemas["WeatherAlertDto"]["kind"];

export type WeatherAlertSeverity = Schemas["WeatherAlertDto"]["severity"];

/** Structured weather alert along a route — the generated `WeatherAlertDto`. */
export type WeatherAlert = Schemas["WeatherAlertDto"];

export type RouteWeatherResponse = Schemas["RouteWeatherResponseDto"];

// ── Accommodations (US-10) ──

export type AccommodationKind = Schemas["AccommodationDto"]["kind"];

/** Nearby lodging (US-10) — the generated `AccommodationDto`. */
export type Accommodation = Schemas["AccommodationDto"];

export type AccommodationList = Schemas["AccommodationListDto"];

// ── Along-route POIs (US-10, US-36) ──

export type PoiKind = Schemas["PoiDto"]["kind"];

/** Nearby POI (US-10) — the generated `PoiDto`. */
export type Poi = Schemas["PoiDto"];

export type PoiList = Schemas["PoiListDto"];

/**
 * POI matched against a route polyline (US-36) — the generated
 * `AlongRoutePoiDto`. Distance is expressed relative to the route (how far
 * along, and how far off).
 */
export type AlongRoutePoi = Schemas["AlongRoutePoiDto"];

export type AlongRoutePoiList = Schemas["AlongRoutePoiListDto"];

// ── Mountain Passes (US-11) ──

export type PassStatus = Schemas["MountainPassDto"]["status"];

/** Mountain pass (US-11) — the generated `MountainPassDto`. */
export type MountainPass = Schemas["MountainPassDto"];

/** `POST /passes/check-route` response — the generated `CheckRouteResponseDto`. */
export type CheckRouteForPassesResponse = Schemas["CheckRouteResponseDto"];

// ── Sensor Data ──

/**
 * One sensor sample. The uploaded fields (`t`, `ax/ay/az`, `lat/lng`, `speed`,
 * `lean_deg`) are the generated `SensorReadingDto` — the wire contract the
 * batch is posted under. The raw gyroscope axes (`gx/gy/gz`) are deliberately
 * on-device only: they feed the complementary filter that derives `lean_deg`
 * (US-19) and are never sent (the backend re-derives everything else from the
 * accelerometer axes), so they extend the DTO here rather than living on it.
 */
export type SensorReading = Schemas["SensorReadingDto"] & {
  /** Gyroscope X — on-device only, consumed by the lean filter. */
  gx?: number;
  /** Gyroscope Y — on-device only. */
  gy?: number;
  /** Gyroscope Z — on-device only. */
  gz?: number;
};

export interface SegmentClassification {
  road_segment_id?: string;
  quality_class: QualityClass;
  quality_score: number;
  surface_type: SurfaceType;
  rms: number;
  confidence: number;
  sample_count: number;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  timestamp: string;
}

// ── Route Calculation ──

export interface RoutePreferences {
  road_preference: "fastest" | "curvy" | "scenic" | "balanced";
  min_quality: number;
  avoid_highway: boolean;
  avoid_toll: boolean;
  avoid_hazards: boolean;
}

export interface CalculatedRoute {
  distance_m: number;
  duration_s: number;
  avg_quality: number;
  geometry: LatLng[];
  segments: {
    road_segment_id: string;
    road_name?: string;
    quality_score: number;
    curviness_score: number;
    surface_type: SurfaceType;
    length_m: number;
    hazard_count: number;
  }[];
}

// ── Group Rides (US-26) ──

/** Group-ride participant (US-26) — the generated `GroupRideMemberDto`. */
export type GroupRideMember = Schemas["GroupRideMemberDto"];

/** Group-ride detail (US-26) — the generated `GroupRideDetailDto`. */
export type GroupRideDetail = Schemas["GroupRideDetailDto"];

export interface GroupPositionEvent {
  group_ride_id: string;
  user_id: string;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  at: string;
}

export interface GroupJoinedEvent {
  group_ride_id: string;
  user_id: string;
  display_name: string;
  at: string;
}

export interface GroupLeftEvent {
  group_ride_id: string;
  user_id: string;
  at: string;
}

export interface GroupEndedEvent {
  group_ride_id: string;
  at: string;
}

// ── Gamification (US-28 / US-29 / US-30) ──
// `UserBadge` (the badge shape) is defined alongside the user types above so
// it stays close to the rider's other profile data. The challenge / exploration
// surfaces below build on top of it.

export type BadgeCategory = "distance" | "exploration" | "community";
export type BadgeTier = "bronze" | "silver" | "gold";

/** `POST /badges/check` response — the generated `CheckBadgesResponseDto`. */
export type CheckBadgesResponse = Schemas["CheckBadgesResponseDto"];

/** Challenge summary — the generated `ChallengeDto`. */
export type Challenge = Schemas["ChallengeDto"];

/** One challenge leaderboard row — the generated `LeaderboardEntryDto`. */
export type ChallengeLeaderboardEntry = Schemas["LeaderboardEntryDto"];

/** Challenge detail (+ my progress + leaderboard) — the generated `ChallengeDetailDto`. */
export type ChallengeDetail = Schemas["ChallengeDetailDto"];

/** `POST /challenges/:id/join` response — the generated `JoinChallengeResponseDto`. */
export type ChallengeJoinResponse = Schemas["JoinChallengeResponseDto"];

/** Rider exploration totals (US-30) — the generated `ExplorationStatsDto`. */
export type ExplorationStats = Schemas["ExplorationStatsDto"];

export type UnriddenSegment = Schemas["UnriddenSegmentDto"];

export type RiddenSegment = Schemas["RiddenSegmentDto"];

export type RiddenSegmentsList = Schemas["RiddenSegmentsListDto"];

// ── Bikes (US-64) ──

/**
 * A bike registered in the rider's garage — the generated `BikeDto` (one of
 * the few camelCase wire DTOs). The mobile HUD surfaces the active bike on
 * `RideActiveScreen` and pins each new ride to it server-side; mobile only
 * consumes the active-bike lookup today (full CRUD lives on the companion).
 */
export type Bike = Schemas["BikeDto"];
