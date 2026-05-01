/**
 * Tarmoto Core Types
 * Mirrors the OpenAPI schema — keep in sync with backend DTOs.
 */

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
  phone?: string;
  /** US-27: avatar URL backed by /users/me/avatar uploads. */
  avatar_url?: string | null;
  /** US-27: free-form rider bio shown on the profile screen. */
  bio?: string | null;
  /** US-27: free-form home region label (e.g. "Beskydy"). */
  home_region?: string | null;
  home_location?: LatLng;
  work_location?: LatLng;
  preferences: UserPreferences;
  created_at: string;
}

/**
 * Public-facing rider profile (US-27). Backed by GET /users/:userId/profile.
 * `is_following` is null when viewing your own profile so the client can
 * hide the follow button rather than render it in a misleading state.
 */
export interface PublicProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  home_region: string | null;
  /** ISO 8601 join timestamp. */
  created_at: string;
  follower_count: number;
  following_count: number;
  is_following: boolean | null;
  is_self: boolean;
}

/** Single row from /users/:userId/followers and /users/:userId/following. */
export interface FollowerListItem {
  user_id: string;
  display_name: string;
  followed_at: string;
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

export interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
  is_emergency: boolean;
  created_at: string;
}

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
  road_name?: string;
  road_number?: string;
  quality_score: number;
  curviness_score: number;
  surface_type: SurfaceType;
  length_m: number;
  confidence: number;
  reading_count: number;
  last_updated: string;
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

export interface RideSummary {
  id: string;
  started_at: string;
  ended_at?: string;
  distance_km: number;
  duration_min: number;
  avg_speed: number;
  avg_road_quality: number;
  ride_type: RideType;
  status: RideStatus;
}

export interface RideDetail extends RideSummary {
  route_geometry: LatLng[];
  max_speed: number;
  elevation_gain: number;
  elevation_loss: number;
  curve_count: number;
  max_lean_angle: number;
  fuel_estimate_l: number;
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
  segments: RideSegment[];
}

export interface RideSegment {
  road_segment_id: string;
  road_name?: string;
  quality_reading: number;
  speed_avg: number;
  lean_angle_max: number;
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
  note?: string;
  confirmations: number;
  reporter: string;
  road_name?: string;
  created_at: string;
  expires_at: string;
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
  title: string;
  region?: string;
  num_days: number;
  status: TripStatus;
  member_count: number;
  created_at: string;
}

export interface Trip extends TripSummary {
  daily_km_min: number;
  daily_km_max: number;
  min_quality: number;
  road_preference: RoadPreference;
  days: TripDay[];
  members: TripMember[];
  invite_code: string;
}

export interface TripDay {
  id: string;
  day_number: number;
  title?: string;
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

export interface Waypoint {
  id: string;
  sequence: number;
  lat: number;
  lng: number;
  name?: string;
  waypoint_type: WaypointType;
  road_segment_id?: string;
  notes?: string;
  duration_min?: number;
}

export interface TripMember {
  user_id: string;
  display_name: string;
  role: "owner" | "admin" | "member";
  joined_at: string;
}

// ── Reviews ──

export interface RoadReview {
  id: string;
  user_display_name: string;
  rating: number;
  // Matches `ReviewResponseDto`: both fields are always present in the
  // response, but `null` when the rider left the field blank. Using
  // `string | null` (not `string | undefined`) so `JSON.stringify` /
  // equality checks against the wire format line up with backend.
  comment: string | null;
  bike_model: string | null;
  /** HTTPS URLs of photos uploaded with the review. Empty array when none. */
  photos: string[];
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

export interface CommuteRoute {
  id: string;
  name: string;
  origin: LatLng;
  destination: LatLng;
  distance_km: number;
  avg_duration_min: number;
  avg_quality: number;
  is_primary: boolean;
  route_geometry: LatLng[];
}

export interface CommuteStatus {
  route: CommuteRoute;
  hazards: Hazard[];
  weather: Weather;
  estimated_time_min: number;
  route_quality: number;
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
}

export interface AccommodationList {
  accommodations: Accommodation[];
  radius_km: number;
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
