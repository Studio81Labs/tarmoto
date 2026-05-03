/**
 * Tarmoto API Service
 *
 * Thin facade over the typed `@tarmoto/openapi` client. Each method
 * resolves a single spec-defined operation; request bodies, path
 * params, and response shapes are all type-checked against the
 * generated `paths` / `components` types. A drift between the backend
 * DTO and a mobile call site shows up as a typecheck failure, which
 * is the whole point of routing through the typed client.
 *
 * The JWT refresh + offline-queue plumbing the old hand-rolled axios
 * client owned now lives in `services/typedClient.ts` (refresh
 * middleware) and the existing queue helpers (sensor / hazard /
 * review). The facade just wires queue callbacks through to the
 * appropriate typed-client call.
 */

import type { components } from "@tarmoto/openapi";
import type { NotificationPreferences } from "@tarmoto/shared";
import type {
  HazardType,
  Hazard,
  RideDetail,
  Severity,
  TripGenerationOptionId,
  TripGenerationResult,
  Trip,
  AuthResponse,
  User,
  MeProfile,
  PublicProfile,
  FollowerListItem,
  UserBadge,
  UserSharedRidesResponse,
  RideResponse,
  RideSummary,
  RoadSegment,
  RoadSegmentDetail,
  FunZone,
  TripSummary,
  CommuteRoute,
  CommuteStatus,
  CommuteAlternativesResponse,
  CommuteStats,
  RouteWeatherResponse,
  LatLng,
  RoadReview,
  ReviewVoteResult,
  MountainPass,
  CheckRouteForPassesResponse,
  SensorReading,
  AccommodationList,
  AlongRoutePoiList,
  PoiKind,
  PoiList,
  EmergencyContact,
  EmergencyContactInput,
  GroupRideDetail,
  CheckBadgesResponse,
  Challenge,
  ChallengeDetail,
  ChallengeJoinResponse,
  ExplorationStats,
  RiddenSegmentsList,
  UnriddenSegment,
  TripSharePublic,
} from "@/types";
import {
  client,
  clearTokens,
  getAccessToken,
  isAuthenticated as hasAccessToken,
  storeTokens,
  rawFetch,
} from "./typedClient";
import {
  drainOfflineQueue,
  submitSensorUpload,
  type DrainResult,
  type SubmitResult,
} from "./offlineQueue";
import {
  drainHazardQueue,
  submitHazardReport,
  type DrainHazardResult,
  type HazardReportPayload,
  type SubmitHazardResult,
} from "./hazardQueue";
import {
  drainReviewQueue,
  submitReviewWithQueue,
  type DrainReviewResult,
  type ReviewSubmissionPayload,
  type SubmitReviewResult,
} from "./reviewQueue";
import { registerForPush, unregisterPush } from "./pushRegistration";

type Schemas = components["schemas"];

/** Top-level error thrown by every facade method on a non-2xx response.
 *  Carries the HTTP status + raw body so callers can branch on auth
 *  failures (401/403) vs validation failures (400/422). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function unwrap<T>(
  result: { data?: T; error?: unknown; response: Response },
  fallbackMessage: string,
): T {
  if (result.error !== undefined) {
    const status = result.response.status;
    const message =
      (result.error as { message?: string } | undefined)?.message ??
      fallbackMessage;
    throw new ApiError(message, status, result.error);
  }
  if (result.data === undefined) {
    // 204s are valid for DELETEs / dismissals — callers should use
    // `unwrapVoid` for those. Reaching here means we expected a body.
    throw new ApiError(
      `Empty response body (${result.response.status})`,
      result.response.status,
      null,
    );
  }
  return result.data;
}

function unwrapVoid(result: { error?: unknown; response: Response }): void {
  if (result.error !== undefined) {
    throw new ApiError(
      (result.error as { message?: string } | undefined)?.message ??
        "Request failed",
      result.response.status,
      result.error,
    );
  }
}

class ApiService {
  // ── Auth ──

  async register(
    email: string,
    password: string,
    display_name: string,
  ): Promise<AuthResponse> {
    const result = await client.POST("/api/v1/auth/register", {
      body: { email, password, display_name },
    });
    const data = unwrap(result, "Registration failed");
    storeTokens(data);
    void registerForPush(this.pushApi());
    return data;
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const result = await client.POST("/api/v1/auth/login", {
      body: { email, password },
    });
    const data = unwrap(result, "Login failed");
    storeTokens(data);
    void registerForPush(this.pushApi());
    return data;
  }

  logout(): void {
    // Snapshot the bearer BEFORE clearing tokens so the device-token
    // DELETE in `unregisterPush` still authenticates after MMKV is
    // wiped and even if a concurrent relogin populates a different
    // user's tokens. See `pushRegistration.unregisterPush` for the
    // race-condition history this guards against.
    const bearer = getAccessToken() ?? undefined;
    clearTokens();
    void unregisterPush(this.pushApi(bearer));
  }

  isAuthenticated(): boolean {
    return hasAccessToken();
  }

  /**
   * Build the callback bag that `pushRegistration` consumes. Wiring
   * device-token register through the typed client gives drift
   * detection on the `/me/devices` shape; the unregister path uses
   * `rawFetch` to bypass the 401 → refresh middleware (a stale bearer
   * on logout would otherwise spin into a refresh loop — see the
   * `unregisterPush` comment).
   */
  private pushApi(bearer?: string) {
    return {
      registerDevice: async (payload: {
        platform: "ios" | "android";
        token: string;
        app_version?: string;
      }): Promise<void> => {
        const result = await client.POST("/api/v1/me/devices", {
          body: payload,
        });
        unwrapVoid(result);
      },
      unregisterDevice: async (token: string): Promise<void> => {
        // The token rides in the request body, not the URL — keeps a
        // ~150-char opaque credential out of access logs.
        await rawFetch("/api/v1/me/devices", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          bearer,
        });
      },
    };
  }

  // ── Users ──

  async getProfile(): Promise<User> {
    const result = await client.GET("/api/v1/users/me");
    return unwrap(result, "Failed to load profile") as User;
  }

  /**
   * Authenticated rider's own profile summary (issue #334) — surfaces
   * `total_hours`, `joined_at` and the basic ride / road / hazard / follow /
   * badge counts in one call so the profile screen does not have to
   * compose the badges, follow, and rides endpoints itself.
   */
  async getMyProfile(): Promise<MeProfile> {
    const result = await client.GET("/api/v1/users/me/profile");
    return unwrap(result, "Failed to load profile summary");
  }

  async updateProfile(updates: Partial<User>): Promise<User> {
    const result = await client.PATCH("/api/v1/users/me", {
      body: updates as Schemas["UpdateProfileDto"],
    });
    return unwrap(result, "Failed to update profile") as User;
  }

  // ── Rider profiles + follow (US-27) ──

  /**
   * Fetch a rider's public profile (display fields + follower/following
   * counts + viewer's `is_following` flag). Powers both the own-profile
   * stats row and the read-only ViewProfile screen so a single endpoint
   * covers both modes.
   */
  async getPublicProfile(userId: string): Promise<PublicProfile> {
    const result = await client.GET("/api/v1/users/{userId}/profile", {
      params: { path: { userId } },
    });
    return unwrap(result, "Failed to load profile");
  }

  async followUser(userId: string): Promise<void> {
    const result = await client.POST("/api/v1/users/{userId}/follow", {
      params: { path: { userId } },
    });
    unwrapVoid(result);
  }

  async unfollowUser(userId: string): Promise<void> {
    const result = await client.DELETE("/api/v1/users/{userId}/follow", {
      params: { path: { userId } },
    });
    unwrapVoid(result);
  }

  async listFollowers(userId: string): Promise<FollowerListItem[]> {
    const result = await client.GET("/api/v1/users/{userId}/followers", {
      params: { path: { userId } },
    });
    return unwrap(result, "Failed to load followers");
  }

  async listFollowing(userId: string): Promise<FollowerListItem[]> {
    const result = await client.GET("/api/v1/users/{userId}/following", {
      params: { path: { userId } },
    });
    return unwrap(result, "Failed to load following");
  }

  async listUserBadges(userId: string): Promise<UserBadge[]> {
    const result = await client.GET("/api/v1/users/{userId}/badges", {
      params: { path: { userId } },
    });
    return unwrap(result, "Failed to load badges") as UserBadge[];
  }

  /**
   * #336: paginated shared rides for the rider's profile. The backend
   * returns only public shares for non-self viewers and 404s for
   * soft-deleted or `profile_visibility = private` riders, so a 404 here
   * is the right cue to render an empty section without an error.
   */
  async listUserSharedRides(
    userId: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<UserSharedRidesResponse> {
    const result = await client.GET("/api/v1/users/{userId}/shared-rides", {
      params: { path: { userId }, query: params },
    });
    return unwrap(
      result,
      "Failed to load shared rides",
    ) as UserSharedRidesResponse;
  }

  /**
   * Upload a new avatar. Mirrors the multipart pattern used by review
   * photo upload — openapi-fetch detects the FormData body and lets
   * the platform set the boundary header itself (Multer rejects
   * requests where the boundary is missing).
   */
  async uploadAvatar(photo: {
    uri: string;
    mimeType?: string;
    fileName?: string;
  }): Promise<User> {
    const form = new FormData();
    // TODO drift-detection-irrelevant: multipart — openapi-fetch lacks
    // first-class RN FormData support, so the casts on the body and the
    // RN file descriptor are necessary to keep the platform in charge of
    // the multipart boundary header. There's no spec-shape to drift
    // against here.
    form.append("file", {
      uri: photo.uri,
      type: photo.mimeType ?? "image/jpeg",
      name: photo.fileName ?? `avatar-${Date.now()}.jpg`,
    } as unknown as Blob);
    const result = await client.POST("/api/v1/users/me/avatar", {
      body: form as unknown as { file: string },
      // openapi-fetch JSON-serialises bodies by default; force the
      // raw FormData through unmodified so the platform sets the
      // multipart boundary.
      bodySerializer: (body) => body as unknown as FormData,
    });
    return unwrap(result, "Failed to upload avatar") as User;
  }

  // ── Emergency Contacts (US-12) ──

  async listContacts(): Promise<EmergencyContact[]> {
    const result = await client.GET("/api/v1/users/me/contacts");
    return unwrap(result, "Failed to load contacts");
  }

  async addContact(input: EmergencyContactInput): Promise<EmergencyContact> {
    const result = await client.POST("/api/v1/users/me/contacts", {
      body: { is_emergency: true, ...input },
    });
    return unwrap(result, "Failed to add contact");
  }

  async updateContact(
    contactId: string,
    input: Partial<EmergencyContactInput>,
  ): Promise<EmergencyContact> {
    const result = await client.PATCH("/api/v1/users/me/contacts/{contactId}", {
      params: { path: { contactId } },
      body: input,
    });
    return unwrap(result, "Failed to update contact");
  }

  async deleteContact(contactId: string): Promise<void> {
    const result = await client.DELETE(
      "/api/v1/users/me/contacts/{contactId}",
      { params: { path: { contactId } } },
    );
    unwrapVoid(result);
  }

  // ── Rides ──

  async startRide(
    type: string = "free",
    tripDayId?: string,
  ): Promise<RideResponse> {
    const result = await client.POST("/api/v1/rides/start", {
      body: {
        ride_type: type as Schemas["StartRideDto"]["ride_type"],
        trip_day_id: tripDayId,
      },
    });
    // /start returns the slim `RideResponseDto`. Detail-only fields
    // (segments, route_geometry, lean_distribution, …) are absent from
    // the JSON, not nulls — call `getRide` to populate them.
    return unwrap(result, "Failed to start ride");
  }

  async stopRide(rideId: string): Promise<RideResponse> {
    const result = await client.POST("/api/v1/rides/{rideId}/stop", {
      params: { path: { rideId } },
    });
    // /stop returns the same slim `RideResponseDto` — see `startRide`.
    return unwrap(result, "Failed to stop ride");
  }

  async getRide(rideId: string): Promise<RideDetail> {
    const result = await client.GET("/api/v1/rides/{rideId}", {
      params: { path: { rideId } },
    });
    return unwrap(result, "Failed to load ride");
  }

  async listRides(
    limit = 20,
    offset = 0,
    type?: string,
  ): Promise<{ rides: RideSummary[]; total: number }> {
    const result = await client.GET("/api/v1/rides", {
      params: {
        query: {
          limit,
          offset,
          type: type as "free" | "commute" | "trip" | "tracked" | undefined,
        },
      },
    });
    return unwrap(result, "Failed to list rides");
  }

  /**
   * Fetch a ride's GPX export as raw XML text. Used by RideDetailScreen's
   * share / export button — the bytes are written to a local file and
   * handed to the system share sheet so the rider can forward to any GPX
   * consumer (Garmin, Komoot, etc.).
   */
  async exportRideGpx(rideId: string): Promise<string> {
    const result = await client.GET("/api/v1/rides/{rideId}/gpx", {
      params: { path: { rideId } },
      parseAs: "text",
    });
    // TODO drift-detection-irrelevant: text-body — the spec marks this
    // operation's response as `content?: never` (no JSON schema), so the
    // typed-client return type is `never` even though `parseAs: "text"`
    // returns the raw GPX XML string. Surfacing `application/gpx+xml`
    // in the backend swagger annotations would let openapi-typescript
    // generate `string` here and the cast can go away.
    return unwrap(result, "Failed to export ride GPX") as unknown as string;
  }

  /**
   * Bulk-export every ride owned by the caller as a single GPX bundle.
   * Used by SettingsScreen's "Export all rides" action so riders can
   * move their full history to Garmin / RideWithGPS without writing a
   * script.
   */
  async exportAllRidesGpx(): Promise<string> {
    const result = await client.GET("/api/v1/rides/export.gpx", {
      parseAs: "text",
    });
    // TODO drift-detection-irrelevant: text-body — same as exportRideGpx.
    return unwrap(result, "Failed to export rides GPX") as unknown as string;
  }

  /**
   * Bulk-export the rider's ride history as tabular CSV (one row per
   * ride). Useful for spreadsheet workflows / fitness analytics tools
   * that don't speak GPX.
   */
  async exportAllRidesCsv(): Promise<string> {
    const result = await client.GET("/api/v1/rides/export.csv", {
      parseAs: "text",
    });
    // TODO drift-detection-irrelevant: text-body — same as exportRideGpx,
    // but for `text/csv`.
    return unwrap(result, "Failed to export rides CSV") as unknown as string;
  }

  // ── Sensor Data ──
  //
  // The raw POST is intentionally private: every ride-stop flow must go
  // through `submitSensorData` so offline rides get queued instead of
  // silently dropped (US-18 AC #4). `flushPendingSensorUploads` shares
  // the same underlying call via the queue's uploader callback.

  private async uploadSensorData(
    rideId: string,
    readings: SensorReading[],
    deviceModel: string,
    modelVersion: string | null,
  ): Promise<{ accepted: number; segments_updated: number }> {
    const result = await client.POST("/api/v1/sensor/upload", {
      body: {
        ride_id: rideId,
        device_model: deviceModel,
        // Telemetry: which on-device classifier was active during this
        // batch (US-3). Omit when the mobile fallback heuristic ran —
        // backend treats missing as "no client model on that device".
        // The backend re-derives `classification` / `surface_type`
        // from raw readings regardless, so this never feeds the labels.
        client_model_version: modelVersion ?? undefined,
        readings: readings as Schemas["UploadSensorDataDto"]["readings"],
      },
    });
    return unwrap(result, "Sensor upload failed") as {
      accepted: number;
      segments_updated: number;
    };
  }

  /**
   * Submit sensor readings via the offline-aware queue (US-18 AC #4).
   * This is the ride-stop flow's entry point — the raw POST is kept
   * private so every caller goes through the queue. `modelVersion` is
   * the active on-device classifier (null = v0 RMS heuristic).
   */
  async submitSensorData(
    rideId: string,
    readings: SensorReading[],
    deviceModel: string,
    modelVersion: string | null,
  ): Promise<SubmitResult> {
    return submitSensorUpload(
      rideId,
      readings,
      deviceModel,
      modelVersion,
      (id, r, model, version) => this.uploadSensorData(id, r, model, version),
    );
  }

  /**
   * Best-effort flush of any pending sensor uploads. Driven by the
   * Settings "Retry now" button and could be called by a future
   * connectivity watcher.
   */
  async flushPendingSensorUploads(): Promise<DrainResult> {
    return drainOfflineQueue((id, r, model, version) =>
      this.uploadSensorData(id, r, model, version),
    );
  }

  // ── Road Segments ──

  async getNearbyRoads(
    lat: number,
    lng: number,
    radius = 5000,
    minQuality?: number,
  ): Promise<RoadSegment[]> {
    const result = await client.GET("/api/v1/roads/nearby", {
      params: { query: { lat, lng, radius, min_quality: minQuality } },
    });
    return unwrap(result, "Failed to load nearby roads") as RoadSegment[];
  }

  async getRoadSegment(segmentId: string): Promise<RoadSegmentDetail> {
    const result = await client.GET("/api/v1/roads/{segmentId}", {
      params: { path: { segmentId } },
    });
    return unwrap(result, "Failed to load road segment");
  }

  async getFunZones(bbox: string): Promise<FunZone[]> {
    const result = await client.GET("/api/v1/roads/fun-zones", {
      params: { query: { bbox } },
    });
    return unwrap(result, "Failed to load fun zones") as FunZone[];
  }

  // ── Hazards ──

  async getHazards(
    lat: number,
    lng: number,
    radius = 10000,
    types?: string,
  ): Promise<Hazard[]> {
    const result = await client.GET("/api/v1/hazards", {
      params: { query: { lat, lng, radius, types } },
    });
    return unwrap(result, "Failed to load hazards") as Hazard[];
  }

  async reportHazard(
    lat: number,
    lng: number,
    type: HazardType,
    severity: Severity = "medium",
    note?: string,
    photoUrl?: string,
  ): Promise<Hazard> {
    const result = await client.POST("/api/v1/hazards", {
      body: {
        lat,
        lng,
        hazard_type: type,
        severity,
        note,
        photo_url: photoUrl,
      },
    });
    return unwrap(result, "Failed to report hazard") as Hazard;
  }

  /**
   * Upload a single hazard photo to /hazards/photos and return the
   * URL the backend persisted it at. Caller submits this URL back as
   * the next report's `photo_url`.
   *
   * Doing the upload separately from the report POST means a network
   * drop after upload but before submit can be retried by the offline
   * queue without re-uploading the bytes (or re-billing storage).
   * Mirrors `uploadReviewPhotos` — same multipart pattern.
   */
  async uploadHazardPhoto(
    photo: { uri: string; mimeType?: string; fileName?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ photo_url: string }> {
    const form = new FormData();
    // TODO drift-detection-irrelevant: multipart — same rationale as
    // `uploadReviewPhotos` / `uploadAvatar`. openapi-fetch can't model
    // RN FormData natively, so the casts below keep the platform in
    // charge of the multipart boundary header.
    form.append("file", {
      uri: photo.uri,
      type: photo.mimeType ?? "image/jpeg",
      name: photo.fileName ?? `hazard-${Date.now()}.jpg`,
    } as unknown as Blob);
    const result = await client.POST("/api/v1/hazards/photos", {
      body: form as unknown as { file: string },
      bodySerializer: (body) => body as unknown as FormData,
      signal: options?.signal,
    });
    return unwrap(result, "Failed to upload hazard photo");
  }

  /**
   * Submit a hazard report through the offline-aware queue (US-4 AC #6).
   * `reportHazard` stays public for the existing call sites that want
   * the raw POST semantics, but every UI flow should funnel through
   * this method so a tunnel-time tap doesn't drop the report.
   *
   * If the payload carries a `photoUri`, the queue uploads the photo
   * first and then submits the report with the returned URL. The
   * upload is wired through the queue's uploader callback so a queued
   * (offline) report drains the photo + submit pair together when
   * connectivity returns — no special handling needed at the call site.
   */
  async submitHazardReport(
    payload: HazardReportPayload,
  ): Promise<SubmitHazardResult> {
    return submitHazardReport(payload, (p) => this.reportHazardWithPhoto(p));
  }

  /** Best-effort flush of any queued hazard reports. */
  async flushPendingHazardReports(): Promise<DrainHazardResult> {
    return drainHazardQueue((p) => this.reportHazardWithPhoto(p));
  }

  /**
   * Internal uploader the queue hands to each drain attempt. Uploads
   * the photo first (when `photoUri` is set) and ignores upload errors
   * so the report still reaches the backend without an attachment —
   * the rider tapped Submit on a hazard, dropping the report because
   * the photo couldn't upload would be the worst outcome.
   *
   * Once the photo URL is known the report POST runs with `photo_url`
   * populated; the backend persists it on the row and surfaces it on
   * `/hazards` and the WebSocket fan-out.
   */
  private async reportHazardWithPhoto(
    payload: HazardReportPayload,
  ): Promise<Hazard> {
    let photoUrl: string | undefined;
    if (payload.photoUri) {
      try {
        const uploaded = await this.uploadHazardPhoto({
          uri: payload.photoUri,
        });
        photoUrl = uploaded.photo_url;
      } catch {
        // Submit the report anyway — losing the photo is better than
        // losing the hazard. The backend supports `photo_url` being
        // omitted, and a future "edit hazard" surface (out of scope
        // here) could let the rider re-attach.
      }
    }
    return this.reportHazard(
      payload.lat,
      payload.lng,
      payload.hazardType,
      payload.severity,
      payload.note,
      photoUrl,
    );
  }

  async confirmHazard(hazardId: string): Promise<Hazard> {
    const result = await client.POST("/api/v1/hazards/{hazardId}/confirm", {
      params: { path: { hazardId } },
    });
    return unwrap(result, "Failed to confirm hazard") as Hazard;
  }

  async dismissHazard(hazardId: string): Promise<void> {
    const result = await client.POST("/api/v1/hazards/{hazardId}/dismiss", {
      params: { path: { hazardId } },
    });
    unwrapVoid(result);
  }

  async getHazardsAlongRoute(
    route: LatLng[],
    bufferM = 200,
  ): Promise<Hazard[]> {
    const result = await client.POST("/api/v1/hazards/route", {
      body: { route, buffer_m: bufferM },
    });
    return unwrap(result, "Failed to load route hazards") as Hazard[];
  }

  // ── Trips ──

  async listTrips(status?: string): Promise<TripSummary[]> {
    const result = await client.GET("/api/v1/trips", {
      params: {
        query: {
          status: status as
            | "active"
            | "completed"
            | "draft"
            | "planned"
            | undefined,
        },
      },
    });
    return unwrap(result, "Failed to load trips") as TripSummary[];
  }

  async createTrip(params: {
    title: string;
    num_days: number;
    region?: string;
    min_quality?: number;
    road_preference?: string;
    daily_km_min?: number;
    daily_km_max?: number;
  }): Promise<Trip> {
    const result = await client.POST("/api/v1/trips", {
      body: params as Schemas["CreateTripDto"],
    });
    return unwrap(result, "Failed to create trip");
  }

  /**
   * Create a trip seeded from a parsed GPX/KML file (US-20). The
   * mobile app parses the file via `@tarmoto/shared` and posts the
   * normalised geometry + waypoints; the backend persists a single
   * planned day with the supplied geometry rather than running the
   * route generator.
   */
  async importTripFromRoute(params: {
    title: string;
    region?: string;
    source_format: "gpx" | "kml";
    geometry: Array<{ lat: number; lng: number }>;
    waypoints?: Array<{ lat: number; lng: number; name?: string }>;
  }): Promise<Trip> {
    const result = await client.POST("/api/v1/trips/import", {
      body: params,
    });
    return unwrap(result, "Failed to import trip");
  }

  async getTrip(tripId: string): Promise<Trip> {
    const result = await client.GET("/api/v1/trips/{tripId}", {
      params: { path: { tripId } },
    });
    return unwrap(result, "Failed to load trip");
  }

  /**
   * Materialise a shared trip into the rider's library while preserving
   * its multi-day structure (#357). Use this for the deep-link handoff
   * flow (`tarmoto://trips/import?token=...`) instead of
   * `importTripFromRoute`, which collapses everything to a single
   * planned day. The backend reads the snapshot from `trip_shares`
   * under the supplied token and reconstructs one `trip_days` row per
   * snapshot day with the original geometry, distance, and waypoints.
   */
  async importTripFromShare(shareToken: string): Promise<Trip> {
    const result = await client.POST("/api/v1/trips/from-share", {
      body: { share_token: shareToken },
    });
    return unwrap(result, "Failed to import shared trip");
  }

  async generateTripRoute(
    tripId: string,
    startLocation: LatLng,
    options: {
      bbox?: string;
      option?: TripGenerationOptionId;
      avoid_highways?: boolean;
      avoid_tolls?: boolean;
      avoid_unpaved?: boolean;
      surfaces?: string[];
    } = {},
  ): Promise<TripGenerationResult> {
    const result = await client.POST("/api/v1/trips/{tripId}/generate", {
      params: { path: { tripId } },
      body: {
        start_location: startLocation,
        avoid_highways: options.avoid_highways ?? false,
        avoid_tolls: options.avoid_tolls ?? false,
        avoid_unpaved: options.avoid_unpaved ?? false,
        bbox: options.bbox,
        option: options.option,
        surfaces: options.surfaces as Schemas["GenerateTripDto"]["surfaces"],
      },
    });
    return unwrap(result, "Failed to generate trip route");
  }

  async joinTrip(tripId: string, inviteCode: string): Promise<void> {
    const result = await client.POST("/api/v1/trips/{tripId}/join", {
      params: { path: { tripId } },
      body: { invite_code: inviteCode },
    });
    unwrapVoid(result);
  }

  /**
   * Fetch the public read-only snapshot for a trip share token (US-39 /
   * #283). Used by the deep-link import flow when the rider opens
   * `tarmoto://trips/import?tripId=...&token=...` from the web companion;
   * the snapshot is then flattened and posted to `/trips/import` to
   * materialise the trip in the rider's library.
   */
  async getTripShare(token: string): Promise<TripSharePublic> {
    const result = await client.GET("/api/v1/trip-shares/{token}", {
      params: { path: { token } },
    });
    return unwrap(result, "Failed to load trip share") as TripSharePublic;
  }

  // ── Group Rides (US-26) ──

  async createGroupRide(name: string): Promise<GroupRideDetail> {
    const result = await client.POST("/api/v1/group-rides", {
      body: { name },
    });
    return unwrap(result, "Failed to create group ride");
  }

  async joinGroupRide(code: string): Promise<GroupRideDetail> {
    const result = await client.POST("/api/v1/group-rides/{code}/join", {
      params: { path: { code } },
    });
    return unwrap(result, "Failed to join group ride");
  }

  async leaveGroupRide(groupRideId: string): Promise<void> {
    const result = await client.POST("/api/v1/group-rides/{id}/leave", {
      params: { path: { id: groupRideId } },
    });
    unwrapVoid(result);
  }

  async endGroupRide(groupRideId: string): Promise<void> {
    const result = await client.POST("/api/v1/group-rides/{id}/end", {
      params: { path: { id: groupRideId } },
    });
    unwrapVoid(result);
  }

  async getGroupRide(groupRideId: string): Promise<GroupRideDetail> {
    const result = await client.GET("/api/v1/group-rides/{id}", {
      params: { path: { id: groupRideId } },
    });
    return unwrap(result, "Failed to load group ride");
  }

  // ── Reviews ──

  async getReviews(segmentId: string): Promise<RoadReview[]> {
    const result = await client.GET("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId } },
    });
    return unwrap(result, "Failed to load reviews") as RoadReview[];
  }

  async submitReview(payload: ReviewSubmissionPayload): Promise<RoadReview> {
    const result = await client.POST("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId: payload.segmentId } },
      body: {
        rating: payload.rating,
        comment: payload.comment ?? undefined,
        bike_model: payload.bikeModel ?? undefined,
        photos: payload.photos ?? undefined,
      },
    });
    return unwrap(result, "Failed to submit review") as RoadReview;
  }

  /**
   * Submit a review through the offline-aware queue (US-25 AC #2).
   * Riders compose reviews curbside on poor cellular; queueing the
   * payload on link drop or transient server failure means the rider
   * doesn't have to retype the form when connectivity returns.
   *
   * `currentUserId` scopes the queue to the active session — entries
   * survive across app launches, but the drain only flushes ones the
   * current user enqueued. Without this, a review queued by user A
   * before sign-out would upload under user B's session after a
   * subsequent login on the same device.
   */
  async submitReviewWithQueue(
    payload: ReviewSubmissionPayload,
    currentUserId: string,
  ): Promise<SubmitReviewResult> {
    return submitReviewWithQueue(
      payload,
      (p) => this.submitReview(p),
      currentUserId,
    );
  }

  /**
   * Best-effort flush of any queued reviews belonging to
   * `currentUserId`. Entries from a different account stay queued so
   * the original user can finish them on their next sign-in.
   */
  async flushPendingReviews(currentUserId: string): Promise<DrainReviewResult> {
    return drainReviewQueue((p) => this.submitReview(p), currentUserId);
  }

  async updateReview(payload: ReviewSubmissionPayload): Promise<RoadReview> {
    const result = await client.PUT("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId: payload.segmentId } },
      body: {
        rating: payload.rating,
        comment: payload.comment ?? undefined,
        bike_model: payload.bikeModel ?? undefined,
        photos: payload.photos ?? undefined,
      },
    });
    return unwrap(result, "Failed to update review") as RoadReview;
  }

  async deleteReview(segmentId: string): Promise<void> {
    const result = await client.DELETE("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId } },
    });
    unwrapVoid(result);
  }

  /**
   * Upload one or more review photos to /roads/:segmentId/reviews/photos
   * (US-55) and return the URLs the backend persisted them at. The
   * caller submits these URLs back as the next review's `photos[]`.
   *
   * Doing the upload separately from the review POST means a network
   * drop after upload but before submit can be retried by the offline
   * queue without re-uploading the bytes (or re-billing storage). The
   * optional `signal` lets callers cancel an in-flight upload (rider
   * tapped × on the thumbnail before its upload finished).
   */
  async uploadReviewPhotos(
    segmentId: string,
    photos: { uri: string; mimeType?: string; fileName?: string }[],
    options?: { signal?: AbortSignal },
  ): Promise<{ photos: string[] }> {
    const form = new FormData();
    // TODO drift-detection-irrelevant: multipart — same rationale as
    // `uploadAvatar`. The Blob / { files: string[] } / bodySerializer
    // casts below keep the platform in charge of the multipart boundary
    // because openapi-fetch can't model RN FormData natively.
    for (const [i, photo] of photos.entries()) {
      // React Native's FormData accepts the `{ uri, type, name }`
      // shape and serialises it into a multipart attachment without
      // us reading the bytes manually. Falling back to image/jpeg
      // covers pickers that don't surface the mime type (older
      // Android camera intents return undefined here).
      form.append("files", {
        uri: photo.uri,
        type: photo.mimeType ?? "image/jpeg",
        name: photo.fileName ?? `review-${Date.now()}-${i}.jpg`,
      } as unknown as Blob);
    }
    const result = await client.POST(
      "/api/v1/roads/{segmentId}/reviews/photos",
      {
        params: { path: { segmentId } },
        // Force the typed client to ship the FormData unmodified so
        // the platform sets the multipart boundary header correctly.
        body: form as unknown as { files: string[] },
        bodySerializer: (body) => body as unknown as FormData,
        signal: options?.signal,
      },
    );
    return unwrap(result, "Failed to upload review photos");
  }

  async voteOnReview(
    reviewId: string,
    isHelpful: boolean,
  ): Promise<ReviewVoteResult> {
    const result = await client.POST("/api/v1/roads/reviews/{reviewId}/vote", {
      params: { path: { reviewId } },
      body: { is_helpful: isHelpful },
    });
    return unwrap(result, "Failed to vote on review");
  }

  async clearReviewVote(reviewId: string): Promise<ReviewVoteResult> {
    const result = await client.DELETE(
      "/api/v1/roads/reviews/{reviewId}/vote",
      { params: { path: { reviewId } } },
    );
    return unwrap(result, "Failed to clear review vote");
  }

  // ── Commute ──

  async getCommuteRoutes(): Promise<CommuteRoute[]> {
    const result = await client.GET("/api/v1/commute/routes");
    return unwrap(result, "Failed to load commute routes");
  }

  async getCommuteStatus(): Promise<CommuteStatus> {
    const result = await client.GET("/api/v1/commute/status");
    return unwrap(result, "Failed to load commute status");
  }

  async getCommuteAlternatives(): Promise<CommuteAlternativesResponse> {
    const result = await client.GET("/api/v1/commute/alternatives");
    return unwrap(result, "Failed to load commute alternatives");
  }

  async getCommuteStats(
    period: "week" | "month" = "week",
  ): Promise<CommuteStats> {
    const result = await client.GET("/api/v1/commute/stats", {
      params: { query: { period } },
    });
    return unwrap(result, "Failed to load commute stats") as CommuteStats;
  }

  async setPrimaryCommuteRoute(routeId: string): Promise<CommuteRoute> {
    const result = await client.PUT(
      "/api/v1/commute/routes/{routeId}/primary",
      { params: { path: { routeId } } },
    );
    return unwrap(result, "Failed to set primary commute route");
  }

  // ── Weather ──

  /**
   * Sample weather along a route polyline (US-13). The backend bounces
   * a request to OpenWeatherMap every ~20km and returns both the per-point
   * conditions and a list of structured alerts the navigation banner uses.
   * Throws on transport errors so callers can decide whether to swallow
   * (NavigationScreen does — riders shouldn't see a weather error popup).
   */
  async getRouteWeather(route: LatLng[]): Promise<RouteWeatherResponse> {
    const result = await client.POST("/api/v1/weather/route", {
      body: { route },
    });
    return unwrap(result, "Failed to load route weather");
  }

  // ── Mountain Passes (US-11) ──

  async getPasses(bbox?: string): Promise<MountainPass[]> {
    const result = await client.GET("/api/v1/passes", {
      params: { query: bbox ? { bbox } : {} },
    });
    return unwrap(result, "Failed to load passes") as MountainPass[];
  }

  async checkRouteForPasses(
    route: LatLng[],
    bufferM?: number,
  ): Promise<CheckRouteForPassesResponse> {
    // Spec marks `buffer_m` as required (see PassesCheckRouteDto) but
    // documents a 1500 m default — when the caller omits it we send
    // the documented default explicitly so the typed body validates.
    const result = await client.POST("/api/v1/passes/check-route", {
      body: { route, buffer_m: bufferM ?? 1500 },
    });
    return unwrap(result, "Failed to check passes");
  }

  // ── POI / Accommodations (US-10) ──

  async listAccommodations(
    lat: number,
    lng: number,
    radiusKm?: number,
  ): Promise<AccommodationList> {
    const result = await client.GET("/api/v1/poi/accommodations", {
      params: { query: { lat, lng, radius_km: radiusKm } },
    });
    return unwrap(result, "Failed to load accommodations");
  }

  async listPois(
    lat: number,
    lng: number,
    options: { radiusKm?: number; kinds?: PoiKind[] } = {},
  ): Promise<PoiList> {
    // openapi-fetch serialises arrays per the spec's style/explode
    // settings (default: explode=true → `?kinds=cafe&kinds=fuel`).
    // The backend accepts either repeated params or a comma-joined
    // string — passing the array directly keeps the typed contract
    // honest instead of casting a comma-string into a PoiKind[].
    const result = await client.GET("/api/v1/poi/nearby", {
      params: {
        query: {
          lat,
          lng,
          radius_km: options.radiusKm,
          kinds: options.kinds?.length ? options.kinds : undefined,
        },
      },
    });
    return unwrap(result, "Failed to load POIs");
  }

  async listPoisAlongRoute(
    route: LatLng[],
    options: { bufferKm?: number; kinds?: PoiKind[] } = {},
  ): Promise<AlongRoutePoiList> {
    // Spec marks `buffer_km` as required (see AlongRoutePoiQueryDto)
    // but documents a 2 km default — send the documented default
    // explicitly when the caller omits it so the body validates.
    const result = await client.POST("/api/v1/poi/along-route", {
      body: {
        route,
        buffer_km: options.bufferKm ?? 2,
        kinds: options.kinds,
      },
    });
    return unwrap(result, "Failed to load POIs along route");
  }

  // ── Gamification: Badges (US-28) ──
  // `listUserBadges` is defined above alongside the rider-profile endpoints
  // — both this surface and ProfileScreen consume it.

  async checkBadges(): Promise<CheckBadgesResponse> {
    const result = await client.POST("/api/v1/badges/check");
    return unwrap(result, "Failed to check badges");
  }

  // ── Gamification: Challenges (US-29) ──

  async listChallenges(): Promise<Challenge[]> {
    const result = await client.GET("/api/v1/challenges");
    return unwrap(result, "Failed to load challenges") as Challenge[];
  }

  async getChallenge(challengeId: string): Promise<ChallengeDetail> {
    const result = await client.GET("/api/v1/challenges/{challengeId}", {
      params: { path: { challengeId } },
    });
    return unwrap(result, "Failed to load challenge");
  }

  async joinChallenge(challengeId: string): Promise<ChallengeJoinResponse> {
    const result = await client.POST("/api/v1/challenges/{challengeId}/join", {
      params: { path: { challengeId } },
    });
    return unwrap(result, "Failed to join challenge") as ChallengeJoinResponse;
  }

  // ── Gamification: Exploration / Personal road map (US-30) ──

  async getExplorationStats(): Promise<ExplorationStats> {
    const result = await client.GET("/api/v1/exploration/stats");
    return unwrap(result, "Failed to load exploration stats");
  }

  async getRiddenSegments(): Promise<RiddenSegmentsList> {
    const result = await client.GET("/api/v1/exploration/ridden-segments");
    return unwrap(result, "Failed to load ridden segments");
  }

  async getNearbyUnriddenSegments(
    lat: number,
    lng: number,
    options: { radiusKm?: number; limit?: number } = {},
  ): Promise<UnriddenSegment[]> {
    const result = await client.GET("/api/v1/exploration/nearby-unridden", {
      params: {
        query: {
          lat,
          lng,
          radius_km: options.radiusKm,
          limit: options.limit,
        },
      },
    });
    return unwrap(
      result,
      "Failed to load unridden segments",
    ) as UnriddenSegment[];
  }

  // ── Notification preferences ──

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    const result = await client.GET("/api/v1/me/notification-preferences");
    return unwrap(result, "Failed to load notification preferences");
  }

  async updateNotificationPreferences(
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const result = await client.PUT("/api/v1/me/notification-preferences", {
      body: patch as Schemas["UpdateNotificationPreferencesDto"],
    });
    return unwrap(result, "Failed to update notification preferences");
  }

  // ── Safety ──

  async sendCrashAlert(
    lat: number,
    lng: number,
    options: {
      rideId?: string;
      speedAtImpact?: number;
      /** `high` triggers an automated voice call alongside SMS. */
      severity?: "low" | "medium" | "high";
      /** Stable client UUID to make retries idempotent. */
      alertId?: string;
      /** BCP-47 locale; defaults to user preferences on the backend. */
      locale?: string;
    } = {},
  ): Promise<CrashAlertResponse> {
    const result = await client.POST("/api/v1/safety/crash-alert", {
      body: {
        lat,
        lng,
        ride_id: options.rideId,
        speed_at_impact: options.speedAtImpact,
        severity: options.severity,
        alert_id: options.alertId,
        locale: options.locale,
      },
    });
    return unwrap(result, "Failed to send crash alert");
  }
}

export interface CrashAlertContactStatus {
  contact_id: string;
  name: string;
  channel: "sms" | "voice" | "log";
  status: "sent" | "failed" | "skipped";
  provider_message_id: string | null;
  error: string | null;
}

export interface CrashAlertResponse {
  contacts_notified: number;
  alert_id: string;
  contacts: CrashAlertContactStatus[];
  idempotent_replay: boolean;
  /**
   * Only meaningful when `idempotent_replay` is true: the original
   * request is still dispatching, so `contacts` may be empty and
   * `contacts_notified` may not yet reflect the final outcome.
   */
  dispatch_in_progress: boolean;
}

export const api = new ApiService();
