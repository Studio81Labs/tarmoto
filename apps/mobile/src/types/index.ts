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
  home_location?: LatLng;
  work_location?: LatLng;
  preferences: UserPreferences;
  created_at: string;
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
  estimated_time_min: number;
  route_geometry: LatLng[];
  waypoints: Waypoint[];
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

export interface Weather {
  temperature_c: number;
  condition: "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog" | "ice";
  wind_kmh: number;
  precipitation_chance: number;
  road_condition: "dry" | "wet" | "icy" | "unknown";
  description: string;
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

// ── Along-route POIs (US-10) ──

export type PoiKind = "restaurant" | "viewpoint" | "cafe";

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
