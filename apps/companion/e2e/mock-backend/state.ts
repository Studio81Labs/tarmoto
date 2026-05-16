import { randomUUID } from "node:crypto";

export interface MockUser {
  id: string;
  email: string;
  password: string;
  display_name: string;
  phone: string | null;
  created_at: string;
}

export interface MockTrip {
  id: string;
  owner_id: string;
  title: string;
  num_days: number;
  daily_km_min?: number;
  daily_km_max?: number;
  min_quality?: number;
  road_preference?: string;
  status: "draft" | "planned" | "active" | "completed";
  members: string[];
  snapshot: Record<string, unknown>;
  /**
   * Folder id this trip is filed under, or null/undefined for unfiled.
   * Mirrors the backend's `TripSummaryDto.folder_id` so the detail
   * response can carry it through into list-view consumers.
   */
  folder_id?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Cloud-synced route collection (US-56). The backend exposes both a
 * private "my collections" surface and a public-by-slug surface; the
 * mock row carries everything both endpoints need to serialise.
 */
export interface MockCollection {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  visibility: "private" | "unlisted" | "public";
  slug: string;
  created_at: string;
  updated_at: string;
}

/**
 * Recorded ride row. Matches the `RideSummary` + `RideDetail` shapes the
 * companion reads from `/api/v1/rides`, `/api/v1/rides/:id`, and
 * `/api/v1/rides/tracks` — list and detail responses are derived from a
 * single row so a test can seed once and exercise both surfaces.
 */
export interface MockRide {
  id: string;
  user_id: string;
  name: string | null;
  ride_type: string;
  status: string;
  started_at: string;
  /**
   * End timestamp. The companion derives `duration_min` from
   * `ended_at - started_at` on both summary and detail responses
   * (production `RidesService` doesn't store a duration column), so
   * the mock derives it the same way at serialise time rather than
   * caching a potentially-inconsistent value here.
   */
  ended_at: string | null;
  distance_km: number;
  avg_speed: number;
  max_speed: number;
  avg_road_quality: number;
  elevation_gain: number;
  elevation_loss: number;
  curve_count: number;
  max_lean_angle: number;
  fuel_estimate_l: number;
  /** Polyline of {lat, lng} points, ordered along direction of travel. */
  route_geometry: Array<{ lat: number; lng: number }>;
  /**
   * Per-segment telemetry powering the speed graph, quality breakdown,
   * and segments table on the detail page. Empty array is the
   * legitimate "no segment telemetry yet" state — keep both branches
   * testable.
   */
  segments: Array<{
    road_name: string | null;
    quality_reading: number | null;
    speed_avg: number | null;
    speed_max: number | null;
    lean_angle_max: number | null;
  }>;
}

export interface MockSuggestion {
  id: string;
  trip_id: string;
  trip_day_id: string | null;
  suggested_by: string;
  suggester_display_name: string;
  road_segment_id: string | null;
  title: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  status: "open" | "accepted" | "rejected";
  up_votes: number;
  down_votes: number;
  votes: Record<string, "up" | "down">;
  created_at: string;
  updated_at: string;
}

export interface MockActivity {
  id: string;
  trip_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface MockRoadReview {
  id: string;
  segment_id: string;
  user_id: string | null;
  user_display_name: string;
  rating: number;
  comment: string | null;
  bike_model: string | null;
  photos: string[] | null;
  created_at: string;
  helpful_count: number;
  not_helpful_count: number;
}

export interface MockShare {
  id: string;
  share_token: string;
  trip_id: string | null;
  title: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface MockBike {
  id: string;
  make: string;
  model: string;
  year: number;
  photoUrl: string | null;
  isActive: boolean;
  totalRides: number;
  totalKm: number;
}

export interface PrivacyPreferencesRow {
  profile_visibility: "public" | "riders-only" | "private";
  default_ride_sharing: "public" | "private";
  road_data_contribution: boolean;
  location_retention: "3months" | "6months" | "1year" | "2years" | "forever";
  analytics_consent: boolean;
  personalized_recommendations_consent: boolean;
}

export interface NotificationPreferencesRow {
  email_digest: "daily" | "weekly" | "never";
  marketing_emails: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  categories: Record<
    string,
    { email: boolean; push: boolean; in_app: boolean }
  >;
}

export interface MockInAppNotification {
  id: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, string>;
  read_at: string | null;
  created_at: string;
}

export interface MockSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  expires_at: number;
}

const DEFAULT_PRIVACY: PrivacyPreferencesRow = {
  profile_visibility: "riders-only",
  default_ride_sharing: "private",
  road_data_contribution: true,
  location_retention: "1year",
  analytics_consent: true,
  personalized_recommendations_consent: true,
};

function buildDefaultNotifications(): NotificationPreferencesRow {
  const cats = [
    "hazard_alert",
    "trip_collaboration",
    "new_follower",
    "route_comment",
    "ride_like",
    "crash_followup",
    "weather_alert",
    "subscription_billing",
  ];
  const categories: NotificationPreferencesRow["categories"] = {};
  for (const c of cats) {
    categories[c] = { email: true, push: true, in_app: true };
  }
  return {
    email_digest: "weekly",
    marketing_emails: false,
    quiet_hours_start: 22,
    quiet_hours_end: 7,
    categories,
  };
}

export class MockState {
  users = new Map<string, MockUser>();
  usersByEmail = new Map<string, string>();
  sessionsByAccess = new Map<string, MockSession>();
  sessionsByRefresh = new Map<string, MockSession>();

  trips = new Map<string, MockTrip>();
  rides = new Map<string, MockRide>();
  collections = new Map<string, MockCollection>();
  collectionsBySlug = new Map<string, string>();
  /**
   * Per-user set of followed collection ids. Mirrors production's
   * `route_collection_follows` table: a row exists per (viewer,
   * collection) pair when the viewer has followed the collection.
   * `RouteCollectionsService.getBySlug` reads this to set
   * `viewer_is_following` on the response.
   */
  collectionFollows = new Map<string, Set<string>>();
  /**
   * Per-share-token metadata for `GET /api/v1/rides/shared/:token`
   * AND the public `/rides/community` feed. The community feed
   * filters by `is_public === true` per
   * `SharingService.listCommunityRides`'s `sr.is_public = true`
   * predicate; private shares stay reachable by token but don't show
   * up in the feed.
   */
  rideShares = new Map<
    string,
    { ride_id: string; is_public: boolean; view_count: number }
  >();
  suggestions = new Map<string, MockSuggestion>();
  activity: MockActivity[] = [];
  roadReviews = new Map<string, MockRoadReview[]>();
  shares = new Map<string, MockShare>();
  sharesByToken = new Map<string, MockShare>();

  bikes = new Map<string, MockBike[]>();
  privacy = new Map<string, PrivacyPreferencesRow>();
  notifications = new Map<string, NotificationPreferencesRow>();
  inAppNotifications = new Map<string, MockInAppNotification[]>();

  subscriptions = new Map<
    string,
    {
      tier: "free" | "premium" | "pro";
      status: "active" | "trialing" | "past_due" | "canceled";
      current_period_end: string;
      cancel_at_period_end: boolean;
    }
  >();

  dataExports = new Map<
    string,
    {
      id: string;
      user_id: string;
      status: "queued" | "processing" | "ready" | "failed" | "expired";
      expiresAt: string;
      createdAt: string;
      completedAt: string | null;
      downloadUrl: string | null;
      byteSize: number | null;
      errorMessage: string | null;
    }
  >();

  deletedUsers = new Set<string>();

  lastCheckoutSession: { user_id: string; url: string; tier: string } | null =
    null;
  lastPortalSession: { user_id: string; url: string; flow: string } | null =
    null;

  reset() {
    this.users.clear();
    this.usersByEmail.clear();
    this.sessionsByAccess.clear();
    this.sessionsByRefresh.clear();
    this.trips.clear();
    this.rides.clear();
    this.rideShares.clear();
    this.collections.clear();
    this.collectionsBySlug.clear();
    this.collectionFollows.clear();
    this.suggestions.clear();
    this.activity = [];
    this.roadReviews.clear();
    this.shares.clear();
    this.sharesByToken.clear();
    this.bikes.clear();
    this.privacy.clear();
    this.notifications.clear();
    this.inAppNotifications.clear();
    this.subscriptions.clear();
    this.dataExports.clear();
    this.deletedUsers.clear();
    this.lastCheckoutSession = null;
    this.lastPortalSession = null;
  }

  createUser(input: {
    email: string;
    password: string;
    display_name: string;
  }): MockUser {
    const id = randomUUID();
    const user: MockUser = {
      id,
      email: input.email.toLowerCase(),
      password: input.password,
      display_name: input.display_name,
      phone: null,
      created_at: new Date().toISOString(),
    };
    this.users.set(id, user);
    this.usersByEmail.set(user.email, id);
    this.privacy.set(id, { ...DEFAULT_PRIVACY });
    this.notifications.set(id, buildDefaultNotifications());
    this.inAppNotifications.set(id, []);
    this.bikes.set(id, []);
    this.subscriptions.set(id, {
      tier: "free",
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });
    return user;
  }

  findUserByEmail(email: string): MockUser | null {
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? (this.users.get(id) ?? null) : null;
  }

  createSession(userId: string): MockSession {
    const access = randomUUID();
    const refresh = randomUUID();
    const session: MockSession = {
      access_token: access,
      refresh_token: refresh,
      user_id: userId,
      expires_at: Date.now() + 60 * 60 * 1000,
    };
    this.sessionsByAccess.set(access, session);
    this.sessionsByRefresh.set(refresh, session);
    return session;
  }

  rotateSession(refreshToken: string): MockSession | null {
    const existing = this.sessionsByRefresh.get(refreshToken);
    if (!existing) return null;
    this.sessionsByAccess.delete(existing.access_token);
    this.sessionsByRefresh.delete(existing.refresh_token);
    return this.createSession(existing.user_id);
  }

  resolveSession(authHeader: string | undefined): MockSession | null {
    if (!authHeader) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return null;
    return this.sessionsByAccess.get(m[1]) ?? null;
  }
}

export const state = new MockState();
