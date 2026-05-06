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
  | "asphalt"
  | "concrete"
  | "cobblestone"
  | "gravel"
  | "dirt";

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

export interface Trip {
  id: string;
  name: string;
  description?: string;
  importSourceFormat?: "gpx" | "kml";
  status: "draft" | "planned" | "active" | "completed";
  days: TripDay[];
  parameters: TripParameters;
  collaborators: TripCollaborator[];
  folderId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TripDay {
  dayNumber: number;
  title?: string;
  waypoints: Waypoint[];
  routeGeometry?: GeoJSON.LineString;
  distanceKm: number;
  durationMinutes: number;
  elevationGain: number;
  avgQuality: number;
  overnightStop?: POI;
  segments?: RoutePreviewSegment[];
}

/**
 * Per-segment preview data surfaced in the trip-planner sidebar (US-33).
 * Decoupled from `RoadSegmentDetail` so the planner can render cards without
 * paying for full segment geometry/reviews; the map layer looks up the same
 * segment by `id` when a card is focused.
 */
export interface RoutePreviewSegment {
  id: string;
  name?: string;
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
  qualityHistory?: { date: string; score: number }[];
  /**
   * Regional average quality score sampled over time, used by the quality
   * trend graph (US-45) to contextualise this segment's history against the
   * surrounding area. Dates don't need to align with `qualityHistory`; the
   * chart interpolates at render time.
   */
  regionalQualityHistory?: { date: string; score: number }[];
  bounds?: [[number, number], [number, number]];
}

export interface Waypoint {
  id: string;
  name?: string;
  location: { lng: number; lat: number };
  type: "start" | "via" | "end" | "fuel" | "rest" | "photo" | "accommodation";
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
  earnedAt?: string;
}

export interface Bike {
  id: string;
  make: string;
  model: string;
  year: number;
  photoUrl?: string;
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
  type: "accommodation" | "fuel" | "restaurant" | "viewpoint" | "cafe";
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
  | "3months"
  | "6months"
  | "1year"
  | "2years"
  | "forever";

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
