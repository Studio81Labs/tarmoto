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
import type { HazardSeverity, HazardType, SurfaceType } from "@tarmoto/shared";
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

export interface FunZone {
  id: string;
  name: string | null;
  composite_score: number;
  road_count: number;
  total_curve_km: number | null;
  avg_quality: number | null;
  best_season: string | null;
  boundary: LatLng[];
}

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

export interface Hazard {
  id: string;
  lat: number;
  lng: number;
  hazard_type: HazardType;
  severity: Severity;
  note: string | null;
  /**
   * Public URL of the photo attached to this hazard, when present.
   * Hosted on Tarmoto media storage and safe to render directly via
   * `<Image source={{ uri: photo_url }} />` in the hazard callout.
   */
  photo_url: string | null;
  confirmations: number;
  reporter: string | null;
  road_name: string | null;
  created_at: string;
  expires_at: string;
}

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

/**
 * Public read-only payload from `GET /trip-shares/:token` (US-39 / #283) —
 * the generated `TripSharePublicDto`. `snapshot` is the companion's serialised
 * `Trip` shape, kept as an opaque record on the wire.
 */
export type TripSharePublic = Schemas["TripSharePublicDto"];

// ── Reviews ──

export interface RoadReview {
  id: string;
  /**
   * Author user id, used to deep-link the review byline to the rider
   * profile. `null` when the author has been soft-deleted (paired with
   * the masked "Deleted user" display name) — the card should hide the
   * profile link in that case.
   */
  user_id: string | null;
  user_display_name: string;
  rating: number;
  // Matches `ReviewResponseDto`: both fields are always present in the
  // response, but `null` when the rider left the field blank. Using
  // `string | null` (not `string | undefined`) so `JSON.stringify` /
  // equality checks against the wire format line up with backend.
  comment: string | null;
  bike_model: string | null;
  /**
   * HTTPS URLs of photos uploaded with the review. Empty array when
   * none. `null` when the author has been masked (deleted or
   * `profile_visibility = 'private'`) — managed photo URLs embed
   * the author's id in their filename, so the backend suppresses
   * the array on masked surfaces to avoid leaking the rider's UUID
   * through the path even when `user_id` is null (#279 / #501).
   */
  photos: string[] | null;
  created_at: string;
  /** Helpful votes cast by other riders. Always present (zero when none). */
  helpful_count: number;
  /** Not-helpful votes cast by other riders. Always present (zero when none). */
  not_helpful_count: number;
  /**
   * The signed-in viewer's own vote on this review. `null` when the viewer
   * hasn't voted, or is anonymous — which is also the case on the
   * embedded-reviews field of a road-detail response, since that endpoint
   * doesn't personalise per viewer.
   */
  my_vote: boolean | null;
  /**
   * True when this review belongs to the authenticated caller, false
   * otherwise. The /roads/:id embedded-reviews shortcut always reports
   * `false` (anonymous-friendly), so the form mounts /roads/:id/reviews
   * separately when it needs to know whether the rider already has a
   * review on this segment.
   */
  is_mine: boolean;
}

/** Result of POST / DELETE /roads/reviews/:reviewId/vote. */
export interface ReviewVoteResult {
  helpful_count: number;
  not_helpful_count: number;
  my_vote: boolean | null;
}

// ── Commute ──

/**
 * Saved commute route. Mirrors the wire shape `CommuteRouteResponseDto`.
 * The cache fields (`distance_km`, `avg_duration_min`, `route_geometry`)
 * are nullable: a freshly-saved row stays null until the routing
 * provider resolves it, and the backend logs+leaves them null on a
 * provider outage so the screen can still render the rest of the route.
 */
export interface CommuteRoute {
  id: string;
  name: string;
  origin: LatLng;
  destination: LatLng;
  distance_km: number | null;
  avg_duration_min: number | null;
  route_geometry: LatLng[] | null;
  avg_quality: number | null;
  is_primary: boolean;
  /** ISO timestamp from the backend. Optional only because pre-existing
   *  test fixtures predate the field — the wire shape is required. */
  created_at?: string;
}

/**
 * Mobile-side commute status shape. Mirrors the wire DTO
 * `CommuteStatusResponseDto` — backend composes hazards + weather
 * inline (#353) so the rider gets one round-trip. Weather is
 * nullable because the backend serves the rest of the payload even
 * when the weather provider is briefly unreachable.
 */
export interface CommuteStatus {
  route: CommuteRoute;
  hazards: Hazard[];
  weather: Weather | null;
  estimated_time_min: number | null;
  route_quality: number | null;
  status: "clear" | "hazards" | "weather_warning" | "delays";
}

/**
 * Alternative route returned by GET /commute/alternatives.
 *
 * Each candidate carries the geometry the routing engine produced plus
 * the same hazard / quality enrichment we run for the primary route, so
 * the rider can compare options side-by-side without a follow-up fetch.
 */
export interface CommuteAlternativeRoute {
  distance_km: number;
  duration_min: number;
  /** Average road quality 0–5; null when no scored segments overlap. */
  avg_quality: number | null;
  /** Active hazards within 500 m of the alternative geometry. */
  hazard_count: number;
  geometry: LatLng[];
}

export interface CommuteAlternativesResponse {
  primary_route: CommuteRoute;
  primary_hazard_count: number;
  alternatives: CommuteAlternativeRoute[];
}

export interface CommuteStatsPeriod {
  total_rides: number;
  total_km: number;
  total_time_min: number;
  avg_duration_min: number;
  fuel_estimate_l: number;
}

export interface CommuteStatsDailyBreakdown {
  date: string;
  rides: number;
  km: number;
  duration_min: number;
}

export interface CommuteStats {
  period: "week" | "month";
  total_rides: number;
  total_km: number;
  total_time_min: number;
  avg_duration_min: number;
  fuel_estimate_l: number;
  daily_breakdown: CommuteStatsDailyBreakdown[];
  /** Same shape as the current period, for the immediately prior window. */
  previous_period: CommuteStatsPeriod;
}

export interface Weather {
  temperature_c: number;
  condition: "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog" | "ice";
  wind_kmh: number;
  precipitation_chance: number;
  road_condition: "dry" | "wet" | "icy" | "unknown";
  description: string;
}

export interface RouteWeatherPoint extends Weather {
  lat: number;
  lng: number;
}

export type WeatherAlertKind = "storm" | "ice" | "wet" | "wind";

export type WeatherAlertSeverity = "info" | "warning" | "critical";

export interface WeatherAlert {
  id: string;
  kind: WeatherAlertKind;
  severity: WeatherAlertSeverity;
  lat: number;
  lng: number;
  /** Distance from the route start (km), measured along the polyline. */
  distance_km_from_start: number;
  title: string;
  message: string;
}

export interface RouteWeatherResponse {
  points: RouteWeatherPoint[];
  has_alerts: boolean;
  /** Plain-text alert summaries — kept for backwards compatibility. */
  alerts: string[];
  /** Structured alerts — what the navigation banner consumes. */
  typed_alerts: WeatherAlert[];
}

// ── Accommodations (US-10) ──

export type AccommodationKind =
  | "hotel"
  | "motel"
  | "hostel"
  | "guest_house"
  | "apartment"
  | "chalet"
  | "camp_site";

export interface Accommodation {
  external_id: string;
  name: string | null;
  kind: AccommodationKind;
  lat: number;
  lng: number;
  distance_km: number;
  website: string | null;
  phone: string | null;
  stars: number | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  osm_url: string | null;
  maps_url: string;
}

export interface AccommodationList {
  accommodations: Accommodation[];
  radius_km: number;
  /** Echo of the kinds actually queried — matches the POI list endpoints. */
  kinds: AccommodationKind[];
}

// ── Along-route POIs (US-10, US-36) ──

export type PoiKind = "restaurant" | "viewpoint" | "cafe" | "fuel_station";

export interface Poi {
  external_id: string;
  name: string | null;
  kind: PoiKind;
  lat: number;
  lng: number;
  distance_km: number;
  website: string | null;
  phone: string | null;
  hint: string | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  cuisine: string | null;
  brand: string | null;
  osm_url: string | null;
  maps_url: string;
}

export interface PoiList {
  pois: Poi[];
  radius_km: number;
  kinds: PoiKind[];
}

/**
 * POI matched against a route polyline (US-36). Unlike `Poi` the
 * distance is expressed relative to the route: how far the POI sits
 * along the route from its start, and how far it is off the route.
 */
export interface AlongRoutePoi {
  external_id: string;
  name: string | null;
  kind: PoiKind;
  lat: number;
  lng: number;
  distance_along_route_km: number;
  distance_from_route_km: number;
  website: string | null;
  phone: string | null;
  hint: string | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  cuisine: string | null;
  brand: string | null;
  osm_url: string | null;
  maps_url: string;
}

export interface AlongRoutePoiList {
  pois: AlongRoutePoi[];
  buffer_km: number;
  kinds: PoiKind[];
  route_length_km: number;
}

// ── Mountain Passes (US-11) ──

export type PassStatus = "open" | "closed" | "unknown";

export interface MountainPass {
  id: string;
  name: string;
  country_code: string;
  region: string | null;
  lat: number;
  lng: number;
  elevation_m: number;
  typical_open_month: number; // 1..12
  typical_close_month: number; // 1..12
  status: PassStatus;
  status_overridden: boolean;
  notes: string | null;
  last_updated: string;
}

export interface CheckRouteForPassesResponse {
  passes: MountainPass[];
  closed_count: number;
  unknown_count: number;
}

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

export interface GroupRideMember {
  user_id: string;
  display_name: string;
  joined_at: string;
  last_lat: number | null;
  last_lng: number | null;
  last_speed: number | null;
  last_heading: number | null;
  last_position_at: string | null;
  recent_path: { lat: number; lng: number; at: string }[];
}

export interface GroupRideDetail {
  id: string;
  owner_id: string;
  name: string;
  code: string;
  started_at: string;
  ended_at: string | null;
  members: GroupRideMember[];
}

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

export interface CheckBadgesResponse {
  newly_earned: string[];
}

export interface Challenge {
  id: string;
  title: string;
  description: string;
  metric: string;
  target: number;
  starts_at: string;
  ends_at: string;
  reward_badge_key: string | null;
  participant_count: number;
}

export interface ChallengeLeaderboardEntry {
  rank: number;
  user_id: string;
  display_name: string;
  progress: number;
  completed: boolean;
}

export interface ChallengeDetail extends Challenge {
  my_progress: number | null;
  my_completed: boolean | null;
  leaderboard: ChallengeLeaderboardEntry[];
}

export interface ChallengeJoinResponse {
  challenge_id: string;
  joined_at: string;
}

export interface ExplorationStats {
  ridden_segments: number;
  total_segments: number;
  percent_explored: number;
  total_distance_km: number;
}

export type UnriddenSegment = Schemas["UnriddenSegmentDto"];

export type RiddenSegment = Schemas["RiddenSegmentDto"];

export type RiddenSegmentsList = Schemas["RiddenSegmentsListDto"];

// ── Bikes (US-64) ──

/**
 * A bike registered in the rider's garage. The mobile HUD surfaces
 * the active bike on `RideActiveScreen` and pins each new ride to it
 * server-side. Camel-cased keys mirror the backend's `BikeDto`.
 *
 * Mobile only consumes the active-bike lookup today; the full CRUD
 * lives on the companion. CRUD-input shapes will land here when a
 * mobile garage screen ships.
 */
export interface Bike {
  id: string;
  make: string;
  model: string;
  year: number | null;
  isActive: boolean;
  photoUrl: string | null;
  icon: string | null;
  notes: string | null;
  totalKm: number;
  totalRides: number;
  createdAt: string;
  updatedAt: string;
}
