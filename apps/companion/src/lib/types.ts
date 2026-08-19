import type * as GeoJSON from "geojson";
import type { HazardType, SubscriptionTier } from "@tarmoto/shared";

// Re-export so callers that already import from `@/lib/types` keep working.
// New code should import `HazardType` directly from `@tarmoto/shared` (the
// canonical source, mirroring how `SurfaceType` is imported in map-filters).
export type { HazardType };

// ── User ──

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  homeRegion?: string;
  tier: SubscriptionTier;
  createdAt: string;
}

// ── Road Quality ──

export type QualityTier = "excellent" | "good" | "fair" | "poor" | "very-poor";
export type SurfaceType =
  "asphalt" | "concrete" | "cobblestone" | "gravel" | "dirt";

export interface RoadSegment {
  id: string;
  osmWayId: number;
  name?: string;
  geometry: GeoJSON.LineString;
  qualityScore: number; // 1-5
  qualityTier: QualityTier;
  surfaceType: SurfaceType;
  curvinessScore: number; // 0-100
  confidence: number; // 0-1
  riderPasses: number;
  lastUpdated: string;
}

export interface RoadSegmentDetail extends RoadSegment {
  qualityHistory: { date: string; score: number }[];
  photos: SegmentPhoto[];
  reviews: SegmentReview[];
  activeHazards: Hazard[];
  elevationProfile: number[];
}

export interface SegmentPhoto {
  id: string;
  url: string;
  riderId: string;
  riderName: string;
  createdAt: string;
}

export interface SegmentReview {
  id: string;
  riderId: string;
  riderName: string;
  riderAvatar?: string;
  rating: number; // 1-5
  text: string;
  photos: string[];
  helpful: number;
  createdAt: string;
}

// ── Hazards ──

export interface Hazard {
  id: string;
  type: HazardType;
  location: GeoJSON.Point;
  reporterId: string;
  reporterName: string;
  severity: "low" | "medium" | "high";
  note?: string;
  confirmations: number;
  createdAt: string;
  expiresAt: string;
}

// ── Trips ──
//
// The backend exposes two distinct shapes:
// - `GET /api/v1/trips` (list) → `TripSummaryDto[]` — no `days`,
//   no `parameters`, no `collaborators`; carries `num_days`,
//   `member_count`, etc.
// - `GET /api/v1/trips/:id` (detail) → `TripDetailDto extends
//   TripSummaryDto` — full shape with day-by-day breakdown.
//
// Modelling them as separate interfaces lets the compiler reject
// list-endpoint consumers that touch detail-only fields. Before
// this split, the merged `Trip` type lied — `days` was declared
// required but absent at runtime on list responses, surfacing as
// crashes (see #541 / the `tripTotalKm` regression).
//
// `Trip` stays as a transitional alias for `TripDetail` so existing
// detail-flow imports keep working; new code should import
// `TripSummary` or `TripDetail` explicitly.

/** Fields both endpoints return — list + detail. */
export interface TripSummary {
  id: string;
  name: string;
  status: "draft" | "planned" | "active" | "completed";
  /**
   * Number of days on the trip, surfaced on the wire as `num_days`.
   * Authoritative on summary responses (list endpoint); on detail
   * responses `TripDetail.days.length` is the real count, but the
   * field is still populated so summary→detail derivations stay
   * lossless.
   */
  num_days: number;
  /**
   * Number of members on the trip, including the owner.
   * Backend surfaces this as `member_count` on summary responses.
   */
  member_count?: number;
  region?: string | null;
  /**
   * US-37 — owner uuid surfaced on the wire for the trips list. Used
   * by the duplicate flow to decide whether to carry the source's
   * `folder_id` forward (folders are private per-user). Optional
   * because the planner-side `tripFromDetail` adapter doesn't
   * always populate it from the detail response.
   */
  owner_id?: string | undefined;
  /**
   * US-37 — backend-persisted folder uuid. Null/undefined for
   * unfiled trips. Snake_case to mirror the wire format so
   * consumers can read the API response without an adapter pass.
   */
  folder_id?: string | null;
  createdAt: string;
  /**
   * Issue #647 — summary meta surfaced on the list endpoint so trip
   * cards can render their KM / DAYS / PASSES strip + quality bars +
   * updated-time footer without hydrating per-trip detail. All
   * optional: backend ships them incrementally; cards hide
   * whichever fields are missing on a given response.
   */
  distance_km?: number | null;
  passes_count?: number | null;
  quality_avg?: number | null;
  warnings_count?: number | undefined;
  updatedAt?: string | undefined;
  /**
   * Per-day simplified route outline ([lng, lat] polylines) for the trips-list
   * card thumbnail. `null`/absent for trips with no routed geometry (drafts).
   */
  overviewGeometry?: number[][][] | null | undefined;
}

/** Hydrated detail — extends summary with day-level + planner data. */
export interface TripDetail extends TripSummary {
  description?: string;
  importSourceFormat?: "gpx" | "kml";
  /**
   * Day-by-day breakdown. Hydrated by `tripFromDetail` for detail
   * responses. Absent on summary rows — type-checked at compile
   * time now that `TripSummary` doesn't carry `days`.
   */
  days: TripDay[];
  parameters: TripParameters;
  collaborators: TripCollaborator[];
  updatedAt: string;
}

/**
 * Transitional alias kept so detail-flow imports
 * (`import type { Trip } from "@/lib/types"`) keep working without
 * a sweep. New code should import `TripDetail` (or `TripSummary`
 * on list surfaces) directly.
 */
export type Trip = TripDetail;

export interface TripDay {
  dayNumber: number;
  title?: string | undefined;
  waypoints: Waypoint[];
  routeGeometry?: GeoJSON.LineString | undefined;
  distanceKm: number;
  durationMinutes: number;
  elevationGain: number;
  avgQuality: number;
  /**
   * Metres ridden per surface key for this day's routed geometry, straight
   * from the routing response. Present only after live routing previews the
   * day; loaded/imported trips derive a fallback mix from quality segments.
   */
  surfaceMix?: Record<string, number> | undefined;
  overnightStop?: POI | undefined;
  segments?: RoutePreviewSegment[] | undefined;
  /**
   * Client-only (never saved): real per-segment surface quality for this day's
   * routed polyline, fetched from `POST /roads/route-quality` after the
   * geometry commits (#862). The map line and Inspect strip prefer these over
   * the geometry-only `no_data` baseline. Cleared whenever `routeGeometry`
   * changes so stale quality can't outlive the line it was computed for.
   */
  qualitySegments?: import("@/lib/planner/types").RouteSegment[] | undefined;
  /** True when this day's start is linked to the previous day's end (multi-day planner). */
  startLinked?: boolean;
  /**
   * Per-leg road-character overrides as saved (revision 3 §C): one
   * preference per consecutive routing-waypoint pair, travel order. The
   * planner re-seeds its leg-override state from this on load.
   */
  legPreferences?: import("./planner/prefs").RoadPreference[] | null;
  /**
   * Client-only (never saved): where each routing leg starts in
   * `routeGeometry` when the day was routed per leg (revision 3 §C).
   * Lets quality segments be tagged with their legId on derivation.
   */
  legBreaks?: Array<{ legId: string; startVertex: number }> | undefined;
}

/**
 * Per-segment preview data surfaced in the trip-planner sidebar (US-33).
 * Decoupled from `RoadSegmentDetail` so the planner can render cards without
 * paying for full segment geometry/reviews; the map layer looks up the same
 * segment by `id` when a card is focused.
 */
export interface RoutePreviewSegment {
  id: string;
  name?: string | undefined;
  dayNumber: number;
  orderInDay: number;
  distanceKm: number;
  qualityScore: number; // 1-5
  qualityTier: QualityTier;
  surfaceType: SurfaceType;
  curvinessScore: number; // 0-100
  elevationProfile: number[];
  photos: SegmentPhoto[];
  activeHazards: Hazard[];
  qualityHistory?: { date: string; score: number }[] | undefined;
  /**
   * Regional average quality score sampled over time, used by the quality
   * trend graph (US-45) to contextualise this segment's history against the
   * surrounding area. Dates don't need to align with `qualityHistory`; the
   * chart interpolates at render time.
   */
  regionalQualityHistory?: { date: string; score: number }[] | undefined;
  bounds?: [[number, number], [number, number]] | undefined;
}

export interface Waypoint {
  id: string;
  name?: string | undefined;
  /**
   * Client-side provenance for a rider/source-owned name. The backend does not
   * yet persist name provenance, so imports, hydrated server names, POI
   * placement, and rider renames set this flag to keep legitimate labels such
   * as "Start" or "Via 1" from being mistaken for legacy generated roles.
   */
  nameIsSource?: boolean;
  location: { lng: number; lat: number };
  type: "start" | "via" | "end" | "fuel" | "rest" | "photo" | "accommodation";
  /**
   * Set when the waypoint was placed from a map POI pin (revision 4):
   * the map renders the category glyph inside the role circle and
   * clicking it reopens the POI popover. Persisted as semantic metadata so
   * unnamed POIs remain localizable after save/reload.
   */
  poiCategory?: import("@/lib/planner/types").PoiCategory;
}

export interface TripParameters {
  days: number;
  dailyKmTarget: number;
  roadPreference: "curvy" | "scenic" | "mixed" | "direct";
  surfacePreference: SurfaceType[];
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
  minQuality: number; // 1-5
}

export interface TripCollaborator {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  role: "owner" | "editor" | "viewer";
}

// ── Rides ──

export interface Ride {
  id: string;
  name?: string;
  startedAt: string;
  finishedAt: string;
  distanceKm: number;
  durationMinutes: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  elevationGain: number;
  routeGeometry: GeoJSON.LineString;
  qualityBreakdown: Record<QualityTier, number>; // percentage per tier
  bikeId?: string;
}

export interface RideDetail extends Ride {
  speedProfile: { timestamp: string; speed: number }[];
  elevationProfile: { distance: number; elevation: number }[];
  segments: RoadSegment[];
  photos: string[];
}

// ── Community ──

export interface RiderProfile {
  id: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  homeRegion?: string;
  bikes: Bike[];
  stats: RiderStats;
  badges: Badge[];
  isFollowing: boolean;
}

export interface RiderStats {
  totalKm: number;
  totalRides: number;
  totalHours: number;
  roadsDiscovered: number;
  hazardsReported: number;
  joinedAt: string;
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  earnedAt?: string | undefined;
}

export interface Bike {
  id: string;
  make: string;
  model: string;
  year: number;
  photoUrl?: string;
  icon?: string | null;
  notes?: string | null;
  isActive: boolean;
  totalKm: number;
  totalRides?: number;
}

export interface RouteCollection {
  id: string;
  name: string;
  description?: string;
  riderId: string;
  riderName: string;
  routes: Trip[];
  isPublic: boolean;
  createdAt: string;
}

// ── Shared ──

export interface POI {
  id: string;
  name: string;
  /** See `Waypoint.nameIsSource`; used by itinerary-only POI projections. */
  nameIsSource?: boolean;
  type: "accommodation" | "fuel" | "restaurant" | "viewpoint" | "cafe";
  /** Semantic planner category used when the source has no custom place name. */
  poiCategory?: import("@/lib/planner/types").PoiCategory;
  location: { lng: number; lat: number };
  rating?: number;
  priceLevel?: number;
}

export interface FunZone {
  id: string;
  name: string;
  center: { lng: number; lat: number };
  bounds: GeoJSON.Polygon;
  compositeScore: number;
  segmentCount: number;
  avgQuality: number;
  avgCurviness: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ── Privacy settings ──

export type ProfileVisibility = "public" | "riders-only" | "private";
export type RideSharingDefault = "public" | "private";
export type LocationRetention =
  "3months" | "6months" | "1year" | "2years" | "forever";

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  defaultRideSharing: RideSharingDefault;
  roadDataContribution: boolean;
  locationRetention: LocationRetention;
  analyticsConsent: boolean;
  personalizedRecommendationsConsent: boolean;
}

// ── Notification preferences ──
//
// Canonical shape lives in `@tarmoto/shared` (`NotificationPreferences`,
// `NotificationChannelToggles`, `EmailDigestFrequency`,
// `NOTIFICATION_CATEGORIES`). Importers in this app should pull from
// `@tarmoto/shared` directly or via `@/lib/notification-preferences`.
