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
import type { FeatureSnapshot, SubscriptionTier } from "@tarmoto/shared";

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

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: User;
}

// ── Users ──

export interface User {
  id: string;
  email: string;
  display_name: string;
  /** Required-but-nullable on the wire (`UserResponseDto.phone`). */
  phone: string | null;
  /** US-27: avatar URL backed by /users/me/avatar uploads. */
  avatar_url: string | null;
  /** US-27: free-form rider bio shown on the profile screen. */
  bio: string | null;
  /** US-27: free-form home region label (e.g. "Beskydy"). */
  home_region: string | null;
  home_location: LatLng | null;
  work_location: LatLng | null;
  /**
   * Lazy JSONB blob — every field is optional because freshly-registered
   * users reach the client before any preference has been toggled. All
   * consumers must default with `?? <default>` rather than assume keys
   * are populated.
   */
  preferences: Partial<UserPreferences>;
  /** The rider's subscription tier — drives feature grants server-side. */
  subscription_tier: SubscriptionTier;
  /**
   * Resolved feature entitlements (tier + overrides), served on
   * `/users/me` and the auth responses. UI gating only — gated endpoints
   * re-check server-side and answer 403 when the feature is off.
   */
  features: FeatureSnapshot;
  created_at: string;
}

/** Single row from /users/:userId/followers and /users/:userId/following. */
export interface FollowerListItem {
  user_id: string;
  display_name: string;
  followed_at: string;
}

/**
 * #336: per-rider shared-ride card returned by
 * `GET /users/:userId/shared-rides`. Drives the "Shared rides" section on
 * both own-profile and view-profile screens. The wire shape mirrors the
 * backend `UserSharedRideDto` — fields stay nullable when the underlying
 * stat hasn't been computed yet so the UI can render placeholders.
 */
export interface UserSharedRide {
  /** Underlying ride id — used to navigate into the ride detail screen. */
  id: string;
  share_token: string;
  /** Rider-given ride name, used as the row title. Null if unset. */
  name: string | null;
  ride_type: string;
  /**
   * Whether the share is publicly visible. Always true for non-self viewers
   * (private shares are filtered server-side); both states appear when the
   * rider is viewing their own list so they can spot rides they later
   * flipped to private.
   */
  is_public: boolean;
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  avg_curviness: number | null;
  duration_min: number | null;
  view_count: number;
  /** ISO 8601 timestamp of when the rider shared the ride (sort key). */
  shared_at: string;
  /** Polyline preview for profile cards. Null when the ride has no track. */
  route_geometry: LatLng[] | null;
}

/** Paginated `GET /users/:userId/shared-rides` response. */
export interface UserSharedRidesResponse {
  items: UserSharedRide[];
  /** Total matches for the rider visible to the viewer (ignores limit/offset). */
  total: number;
  /** Sum of `view_count` across the visible set (ignores limit/offset). */
  total_views: number;
  limit: number;
  offset: number;
}

/** US-27: badge entry as returned by /users/:userId/badges. */
export interface UserBadge {
  key: string;
  name: string;
  description: string;
  category: string;
  tier: string | null;
  /** ISO 8601 timestamp; null when not yet earned. */
  earned_at: string | null;
  progress: {
    current: number;
    bronze: number;
    silver: number;
    gold: number;
  };
}

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

export type SurfaceType =
  | "asphalt"
  | "concrete"
  | "cobblestone"
  | "gravel"
  | "dirt"
  | "unknown";
export type QualityClass = "excellent" | "good" | "fair" | "poor" | "very_poor";

export interface RoadSegment {
  id: string;
  road_name: string | null;
  road_number: string | null;
  /**
   * 1-5 average quality. Null when no surface readings have ever been
   * snapped to this segment (still waiting for the first ride to enrich
   * it) — UI must render a "unscored" placeholder rather than `0`.
   */
  quality_score: number | null;
  curviness_score: number;
  surface_type: SurfaceType;
  length_m: number;
  confidence: number;
  reading_count: number;
  last_updated: string;
  /** Optional. Present on `/roads/nearby` results, absent on detail. */
  distance_m?: number;
}

export interface RoadSegmentDetail extends RoadSegment {
  geometry: LatLng[];
  elevation_min: number | null;
  elevation_max: number | null;
  /**
   * Per-vertex elevation in meters, aligned 1:1 with `geometry`. Null when
   * the backend hasn't ingested an elevation profile for this segment yet —
   * callers should fall back to min/max stats only.
   */
  elevation_profile: number[] | null;
  quality_breakdown: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
    very_poor: number;
  };
  /** Top-N most-recent active hazards on this segment. */
  active_hazards: Hazard[];
  /** Total active hazard count (>= active_hazards.length when truncated). */
  active_hazard_count: number;
  /** Top-N most-recent reviews — full collection lives at /roads/:id/reviews. */
  recent_reviews: RoadReview[];
  review_count: number;
  riders_per_month: number;
  avg_review_rating: number | null;
}

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

export type RideType = "free" | "commute" | "trip" | "tracked";
export type RideStatus = "active" | "completed" | "cancelled";

/**
 * Slim ride shape returned by `/rides/start` and `/rides/stop` (the
 * backend's `RideResponseDto`). It only carries the columns owned by
 * the `rides` row itself — `name` / `duration_min` (computed at list
 * time) and the detail-only enrichments (`segments`, `route_geometry`,
 * `lean_distribution`, …) are absent. Use this when receiving a
 * just-started or just-stopped ride; call `getRide` for the full
 * `RideDetail`.
 */
export interface RideResponse {
  id: string;
  ride_type: RideType;
  status: RideStatus;
  started_at: string;
  ended_at: string | null;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  avg_curviness: number | null;
  /**
   * The bike attributed to this ride. Pinned to the rider's active
   * bike at start time, or null for legacy rides recorded before
   * bike management shipped.
   */
  bike_id: string | null;
}

export interface RideSummary {
  id: string;
  ride_type: RideType;
  status: RideStatus;
  started_at: string;
  ended_at: string | null;
  /**
   * Aggregated per-ride stats. All null while the ride is still active —
   * they are computed at /stop time. UI must default with `?? 0` /
   * `?? "—"` rather than assume a number is present.
   */
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  /**
   * Length-weighted average curviness across snapped segments. Null when
   * no segments are snapped yet.
   */
  avg_curviness: number | null;
  /** Rider-supplied label. Null when not renamed yet. */
  name: string | null;
  duration_min: number | null;
  /**
   * Max absolute lean angle (deg) over the ride. Promoted onto the summary so
   * ride lists (`GET /rides`) carry it — matches the backend `RideSummaryDto`,
   * OpenAPI, and companion. Null while active or when no lean samples exist.
   */
  max_lean_angle: number | null;
}

export interface RideDetail extends RideSummary {
  max_speed: number | null;
  /** Snapped polyline. Null while the ride is still recording or empty. */
  route_geometry: LatLng[] | null;
  elevation_gain: number | null;
  elevation_loss: number | null;
  curve_count: number | null;
  /**
   * US-19 lean histogram. Each bucket carries the number of 1-second
   * sensor windows the rider's absolute lean fell into that bucket.
   * Null when the ride has no lean samples yet (still in progress, or
   * uploaded by an old client that didn't compute lean) — surfaced as
   * an empty distribution by the detail screen.
   */
  lean_distribution: {
    "0_10": number;
    "10_20": number;
    "20_30": number;
    "30_plus": number;
  } | null;
  fuel_estimate_l: number | null;
  segments: RideSegment[];
}

export interface RideSegment {
  road_segment_id: string | null;
  road_name: string | null;
  quality_reading: number | null;
  speed_avg: number | null;
  speed_max: number | null;
  lean_angle_max: number | null;
}

// ── Hazards ──

export type HazardType =
  | "pothole"
  | "gravel"
  | "oil_spill"
  | "roadworks"
  | "animals"
  | "police"
  | "flooding"
  | "ice"
  | "other";

export type Severity = "low" | "medium" | "high";

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

export type TripStatus = "draft" | "planned" | "active" | "completed";
export type RoadPreference = "curvy" | "scenic" | "fast" | "mixed";
export type WaypointType =
  | "start"
  | "via"
  | "fuel"
  | "food"
  | "coffee"
  | "hotel"
  | "photo"
  | "end";

export interface TripSummary {
  id: string;
  /**
   * US-37 — owner uuid surfaced on the wire so callers can decide
   * whether to carry folder assignments forward when duplicating
   * (folders are private per-user; only the owner of the source can
   * preserve filing without 404-ing the create).
   */
  owner_id?: string;
  title: string;
  region: string | null;
  num_days: number;
  status: TripStatus;
  member_count: number;
  /**
   * US-37 — uuid of the rider-owned folder this trip is filed under.
   * `null` (or absent on older API responses) for unfiled trips.
   * Read-only on mobile for v1; folder CRUD lives in the companion.
   */
  folder_id?: string | null;
  created_at: string;
}

// US-37 — rider-owned folder that groups trips. Re-exported from
// `@tarmoto/shared` so backend, mobile, and companion all consume the
// same definition; a field added there propagates here automatically
// and the backend DTO `implements TripFolder`-shape via the wire
// guarantees the three layers stay in lock-step.
export type { TripFolder } from "@tarmoto/shared";

export interface Trip extends TripSummary {
  daily_km_min: number;
  daily_km_max: number;
  min_quality: number;
  road_preference: RoadPreference;
  days: TripDay[];
  members: TripMember[];
}

export interface TripDay {
  id: string;
  day_number: number;
  /**
   * Optional+nullable for the same reason `Waypoint` is — both `null`
   * (the wire shape) and `undefined` (older client fixtures) need to be
   * acceptable. UI must default with `?? "Day N"`.
   */
  title?: string | null;
  distance_km: number;
  avg_quality: number;
  elevation_gain: number;
  elevation_loss: number;
  curviness_score: number;
  scenic_score: number;
  estimated_time_min: number;
  route_geometry: LatLng[];
  waypoints: Waypoint[];
}

export type TripGenerationOptionId = "best-fit" | "scenic" | "fastest";

export interface TripGenerationOption {
  id: TripGenerationOptionId;
  label: string;
  summary: string;
  total_distance_km: number;
  total_duration_min: number;
  avg_quality: number;
  avg_curviness: number;
  avg_scenic: number;
  selected: boolean;
  days: TripDay[];
}

export interface TripGenerationResult {
  trip: Trip;
  selected_option: TripGenerationOptionId;
  options: TripGenerationOption[];
}

/**
 * Trip waypoint. Optional+nullable fields here intentionally widen the
 * spec's `string | null` shape to `string | null | undefined` so existing
 * client-side fixtures that omit a field are still assignable. The real
 * wire shape is still required-nullable; consumers must handle both
 * `null` and `undefined` defensively.
 */
export interface Waypoint {
  id: string;
  sequence: number;
  lat: number;
  lng: number;
  name?: string | null;
  waypoint_type: WaypointType;
  road_segment_id?: string | null;
  notes?: string | null;
  duration_min?: number | null;
}

export interface TripMember {
  user_id: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
  joined_at: string;
}

/**
 * Public read-only payload returned by `GET /trip-shares/:token` (US-39 /
 * #283). The `snapshot` is the companion's local `Trip` shape serialised
 * verbatim — keep it loosely typed here so the mobile import flow can
 * adapt without forcing every web schema change through this file.
 */
export interface TripSharePublic {
  share_token: string;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

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

export interface SensorReading {
  t: number; // Unix ms
  ax: number; // Accelerometer X
  ay: number; // Accelerometer Y
  az: number; // Accelerometer Z
  gx?: number; // Gyroscope X
  gy?: number; // Gyroscope Y
  gz?: number; // Gyroscope Z
  lat?: number;
  lng?: number;
  speed?: number; // m/s
  /**
   * Estimated bike-frame roll (signed, degrees) at this sample, produced
   * by the on-device complementary filter (US-19). Optional because the
   * filter requires both accelerometer + gyroscope to be active and a
   * completed calibration window — pre-calibration samples carry no
   * lean. Backend treats the absent field as "unknown" rather than zero
   * so a quiet sensor doesn't pollute the per-ride histogram.
   */
  lean_deg?: number;
}

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

export interface UnriddenSegment {
  id: string;
  road_name: string | null;
  length_m: number;
  quality_score: number | null;
  surface_type: string;
  distance_m: number;
}

export interface RiddenSegment {
  id: string;
  last_ridden_at: string;
  last_quality_score: number | null;
  ride_count: number;
}

export interface RiddenSegmentsList {
  segments: RiddenSegment[];
}

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
