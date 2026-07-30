/**
 * Tarmoto API Service
 *
 * Thin facade over the typed `@tarmoto/openapi-client` client. Each method
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

import type {
  CalibrationPayload,
  GlobalFeatureStates,
  GlobalLimitOverrides,
  NotificationPreferences,
  RideTagEvent,
} from "@tarmoto/shared";
import type {
  Schemas,
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
  TripFolder,
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
  Bike,
} from "@/types";
import {
  client,
  clearTokens,
  getAccessToken,
  getAuthenticatedUserId,
  getSessionEpoch,
  getCachedUser,
  isAuthenticated as hasAccessToken,
  setCachedUser,
  setAuthenticatedUserId,
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
import { setCachedPreferences } from "./privacyCache";
import { SENSOR_PREPROCESSING_VERSION } from "./sensorsFilter";
import {
  isCurrentAuthSession,
  type AuthSessionSnapshot,
} from "./authBootstrap";
import { t } from "@/i18n";
import { withPreservedEntitlements } from "@/lib/entitlements";

/** Top-level error thrown by every facade method on a non-2xx response.
 *  Carries the HTTP status + raw body so callers can branch on auth
 *  failures (401/403) vs validation failures (400/422). */
export class ApiError extends Error {
  readonly localizedUserMessage = true as const;
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.error !== undefined) {
    const status = result.response.status;
    throw new ApiError(localizedApiErrorMessage(status), status, result.error);
  }
  if (result.data === undefined) {
    // 204s are valid for DELETEs / dismissals — callers should use
    // `unwrapVoid` for those. Reaching here means we expected a body.
    throw new ApiError(
      localizedApiErrorMessage(result.response.status),
      result.response.status,
      null,
    );
  }
  return result.data;
}

function unwrapVoid(result: { error?: unknown; response: Response }): void {
  if (result.error !== undefined) {
    throw new ApiError(
      localizedApiErrorMessage(result.response.status),
      result.response.status,
      result.error,
    );
  }
}

function localizedApiErrorMessage(status: number): string {
  if (status === 401) return t("Your session has expired. Sign in again.");
  if (status === 403) return t("You don't have permission to do that.");
  if (status === 404) return t("The requested item could not be found.");
  if (status === 409) {
    return t(
      "That change conflicts with the current state. Refresh and try again.",
    );
  }
  if (status === 400 || status === 422) {
    return t("Some information is invalid. Check it and try again.");
  }
  if (status >= 500) {
    return t("The server is temporarily unavailable. Try again shortly.");
  }
  return t("Check your connection and try again.");
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
    if (result.error !== undefined && result.response.status === 409) {
      throw new ApiError(
        t("An account with that email already exists"),
        result.response.status,
        result.error,
      );
    }
    const data = unwrap(result);
    storeTokens(data, { newSession: true });
    void registerForPush(this.pushApi());
    // Fire-and-forget so a transient privacy fetch failure can't
    // block sign-up; the cache stays on canonical defaults until
    // the first successful refresh, which is the same posture as
    // a brand-new install (see `privacyCache` doc).
    void this.refreshPrivacyPreferences().catch(() => undefined);
    // Capture the device timezone up front so the very first weekly digest
    // sends at the rider's local Sunday 08:00, not 08:00 UTC (#866).
    void this.syncDeviceTimezone().catch(() => undefined);
    return data;
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const result = await client.POST("/api/v1/auth/login", {
      body: { email, password },
    });
    if (result.error !== undefined && result.response.status === 401) {
      throw new ApiError(
        t("Invalid email or password"),
        result.response.status,
        result.error,
      );
    }
    const data = unwrap(result);
    storeTokens(data, { newSession: true });
    void registerForPush(this.pushApi());
    // See `register` — same fire-and-forget pull so the sensor
    // uploader's `road_data_contribution` gate has fresh data
    // before the rider starts a ride.
    void this.refreshPrivacyPreferences().catch(() => undefined);
    // See `register` — capture the device timezone on sign-in so the digest
    // sends at the rider's local Sunday 08:00, not 08:00 UTC (#866).
    void this.syncDeviceTimezone().catch(() => undefined);
    return data;
  }

  logout(): void {
    // Snapshot the bearer BEFORE clearing tokens so the device-token
    // DELETE in `unregisterPush` still authenticates after MMKV is
    // wiped and even if a concurrent relogin populates a different
    // user's tokens. See `pushRegistration.unregisterPush` for the
    // race-condition history this guards against.
    //
    // #279 / #501 — `clearTokens` itself wipes the privacy cache
    // (alongside the access / refresh / user-id slots) so every
    // token-invalidation path — explicit logout AND silent refresh
    // failure — drops the previous rider's preferences in lockstep.
    // No separate `clearCachedPreferences()` call needed here.
    const bearer = getAccessToken() ?? undefined;
    clearTokens();
    void unregisterPush(this.pushApi(bearer));
  }

  /**
   * Pull the rider's privacy preferences from the backend and
   * persist them in the local cache (#279 / #501). The sensor
   * uploader reads `road_data_contribution` synchronously from the
   * cache before each upload — call this on app foreground / login
   * and after every PUT from the privacy settings screen so the
   * mobile gate stays in sync with the server.
   *
   * Snapshots the AUTHENTICATED USER ID at start and re-checks it
   * before writing the cache (Codex review on PR #513). User id is
   * stable across access-token rotation — only login / register /
   * logout move it — so the 401 refresh middleware silently issuing
   * a new access token mid-flight does NOT cause a stale-snapshot
   * false positive. Snapshot mismatch (logged out, or a different
   * rider signed in) drops the response so we can't repopulate
   * MMKV with the previous rider's toggles after logout cleared
   * it. The earlier access-token-equality version of this guard
   * regressed the normal token-rotation case — see PR #513
   * discussion `r3212738433`.
   *
   * Backfills the persisted user id for installs upgraded from a
   * build that didn't store one (`/users/me` round-trip on the
   * first refresh) — without this, an already-signed-in rider
   * upgrading to this build would never refresh until they signed
   * out and back in. See PR #513 discussion `r3212807027`.
   */
  async refreshPrivacyPreferences(): Promise<void> {
    if (!hasAccessToken()) return;
    let userIdAtStart = getAuthenticatedUserId();
    if (!userIdAtStart) {
      const meResult = await client.GET("/api/v1/users/me");
      const me = unwrap(meResult);
      // #279 / #501 — re-check the session before writing the
      // backfilled id (Codex review on PR #513 r3212865489). A
      // logout that fires while `/users/me` is in flight clears
      // the access token; a fast logout-then-login as a different
      // rider populates `USER_ID_KEY` with the NEW user before our
      // response lands. Either case must NOT clobber the slot with
      // the in-flight call's stale id — the later
      // `getAuthenticatedUserId() !== userIdAtStart` guard below
      // counts on the slot reflecting the current session.
      if (!hasAccessToken()) return;
      const persistedUserId = getAuthenticatedUserId();
      if (persistedUserId && persistedUserId !== me.id) return;
      setAuthenticatedUserId(me.id);
      userIdAtStart = me.id;
    }
    const result = await client.GET("/api/v1/account/privacy");
    const dto = unwrap(result);
    if (getAuthenticatedUserId() !== userIdAtStart) return;
    setCachedPreferences({
      profile_visibility: dto.profile_visibility,
      default_ride_sharing: dto.default_ride_sharing,
      road_data_contribution: dto.road_data_contribution,
      location_retention: dto.location_retention,
      analytics_consent: dto.analytics_consent,
      personalized_recommendations_consent:
        dto.personalized_recommendations_consent,
    });
  }

  isAuthenticated(): boolean {
    return hasAccessToken();
  }

  getAuthSessionSnapshot(): AuthSessionSnapshot | null {
    const accessToken = getAccessToken();
    if (!accessToken) return null;
    return {
      accessToken,
      userId: getAuthenticatedUserId(),
      epoch: getSessionEpoch(),
    };
  }

  /** The id of the currently-signed-in rider (whose bearer token requests
   *  carry), or `null` when signed out. */
  getAuthenticatedUserId(): string | null {
    return getAuthenticatedUserId();
  }

  getCachedProfile(): User | null {
    return getCachedUser();
  }

  cacheProfile(user: User): void {
    setCachedUser(user);
  }

  /**
   * Persist the device's IANA timezone to notification preferences so the
   * weekly digest sends at the rider's local Sunday 08:00 instead of the backend
   * UTC default (#866). Fire-and-forget from login / register (mirrors the
   * privacy / push post-auth hooks) so a fresh sign-in with no cold-start or
   * foreground transition still captures the timezone; also used by the
   * foreground `timezoneSyncMonitor`. Best-effort — the backend falls back to
   * UTC for an unknown/missing zone.
   */
  async syncDeviceTimezone(): Promise<void> {
    if (!hasAccessToken()) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone) return;
    await this.updateNotificationPreferences({
      quiet_hours_timezone: timezone,
    });
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
    return unwrap(result);
  }

  /**
   * Authenticated rider's own profile summary (issue #334) — surfaces
   * `total_hours`, `joined_at` and the basic ride / road / hazard / follow /
   * badge counts in one call so the profile screen does not have to
   * compose the badges, follow, and rides endpoints itself.
   */
  async getMyProfile(): Promise<MeProfile> {
    const result = await client.GET("/api/v1/users/me/profile");
    return unwrap(result);
  }

  async updateProfile(updates: Schemas["UpdateProfileDto"]): Promise<User> {
    const sessionAtStart = this.getAuthSessionSnapshot();
    const result = await client.PATCH("/api/v1/users/me", {
      body: updates,
    });
    const user = unwrap(result);
    if (
      sessionAtStart &&
      isCurrentAuthSession(sessionAtStart, this.getAuthSessionSnapshot(), user)
    ) {
      setCachedUser(withPreservedEntitlements(getCachedUser(), user));
    }
    return user;
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
    return unwrap(result);
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
    return unwrap(result);
  }

  async listFollowing(userId: string): Promise<FollowerListItem[]> {
    const result = await client.GET("/api/v1/users/{userId}/following", {
      params: { path: { userId } },
    });
    return unwrap(result);
  }

  async listUserBadges(userId: string): Promise<UserBadge[]> {
    const result = await client.GET("/api/v1/users/{userId}/badges", {
      params: { path: { userId } },
    });
    return unwrap(result);
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
    return unwrap(result);
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
    const sessionAtStart = this.getAuthSessionSnapshot();
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
    const user = unwrap(result);
    if (
      sessionAtStart &&
      isCurrentAuthSession(sessionAtStart, this.getAuthSessionSnapshot(), user)
    ) {
      setCachedUser(withPreservedEntitlements(getCachedUser(), user));
    }
    return user;
  }

  // ── Emergency Contacts (US-12) ──

  async listContacts(): Promise<EmergencyContact[]> {
    const result = await client.GET("/api/v1/users/me/contacts");
    return unwrap(result);
  }

  async addContact(input: EmergencyContactInput): Promise<EmergencyContact> {
    const result = await client.POST("/api/v1/users/me/contacts", {
      body: { is_emergency: true, ...input },
    });
    return unwrap(result);
  }

  async updateContact(
    contactId: string,
    input: Partial<EmergencyContactInput>,
  ): Promise<EmergencyContact> {
    const result = await client.PATCH("/api/v1/users/me/contacts/{contactId}", {
      params: { path: { contactId } },
      body: input,
    });
    return unwrap(result);
  }

  async deleteContact(contactId: string): Promise<void> {
    const result = await client.DELETE(
      "/api/v1/users/me/contacts/{contactId}",
      { params: { path: { contactId } } },
    );
    unwrapVoid(result);
  }

  // ── Bikes (US-64) ──
  //
  // The rider's garage powers the active-bike chip on `RideActiveScreen`.
  // The full CRUD lives on the companion (which has its own typed
  // client); mobile only needs the active-bike lookup today, so we
  // ship just `getActiveBike` until a mobile garage screen is built.

  async getActiveBike(): Promise<Bike | null> {
    // Dedicated `/account/bikes/active` route — skips the full-list
    // stats aggregation (`COUNT/SUM` over the rides table grouped by
    // bike) that the chip doesn't need, so a `RideActiveScreen` mount
    // is one cheap `findOne` round trip instead.
    const result = await client.GET("/api/v1/account/bikes/active");
    const dto = unwrap(result);
    return dto ? bikeFromSchema(dto) : null;
  }

  // ── Rides ──

  async startRide(
    type: string = "free",
    tripDayId?: string,
    bikeId?: string,
  ): Promise<RideResponse> {
    const result = await client.POST("/api/v1/rides/start", {
      body: {
        ride_type: type as Schemas["StartRideDto"]["ride_type"],
        ...(tripDayId !== undefined ? { trip_day_id: tripDayId } : {}),
        // Omitted ⇒ backend pins to the rider's active bike. Passed
        // explicitly when the rider chose a non-default bike from the
        // garage picker before tapping Start.
        ...(bikeId !== undefined ? { bike_id: bikeId } : {}),
      },
    });
    // /start returns the slim `RideResponseDto`. Detail-only fields
    // (segments, route_geometry, lean_distribution, …) are absent from
    // the JSON, not nulls — call `getRide` to populate them.
    return unwrap(result);
  }

  async stopRide(rideId: string): Promise<RideResponse> {
    const result = await client.POST("/api/v1/rides/{rideId}/stop", {
      params: { path: { rideId } },
    });
    // /stop returns the same slim `RideResponseDto` — see `startRide`.
    return unwrap(result);
  }

  async getRide(rideId: string): Promise<RideDetail> {
    const result = await client.GET("/api/v1/rides/{rideId}", {
      params: { path: { rideId } },
    });
    return unwrap(result);
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
          ...(type !== undefined
            ? { type: type as "free" | "commute" | "trip" | "tracked" }
            : {}),
        },
      },
    });
    return unwrap(result);
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
    return unwrap(result) as unknown as string;
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
    return unwrap(result) as unknown as string;
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
    return unwrap(result) as unknown as string;
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
    tagEvents: RideTagEvent[],
    preprocessingVersion: string | null,
    calibration: CalibrationPayload | null,
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
        ...(modelVersion != null ? { client_model_version: modelVersion } : {}),
        // Issue #493 — marker telling the backend whether `ax/ay/az`
        // in every reading were low-pass-filtered on-device. Sourced
        // from the queued payload, NOT a module constant: rides
        // captured by a pre-#493 build and drained after the user
        // upgrades carry raw axes and must keep their `null` /
        // omitted marker so the backend doesn't mislabel them as
        // filtered. `null` → omit the field (backend treats missing
        // as "raw axes").
        ...(preprocessingVersion != null
          ? { client_preprocessing_version: preprocessingVersion }
          : {}),
        readings: readings as Schemas["UploadSensorDataDto"]["readings"],
        // Research issue #7 — rider-asserted surface labels captured
        // during the ride. Omit the field entirely when none fired so
        // the request stays bytewise-compatible with the older shape
        // the backend still accepts (`tag_events` is optional in the
        // DTO).
        ...(tagEvents.length > 0
          ? {
              tag_events: tagEvents as NonNullable<
                Schemas["UploadSensorDataDto"]["tag_events"]
              >,
            }
          : {}),
        // Issue #494 — idle-baseline calibration for this ride.
        // Omitted when the rider's calibration window was abandoned
        // (sub-floor sample count or no stationary capture at all);
        // the backend treats absent calibration as
        // `calibration_quality: null`.
        ...(calibration
          ? {
              calibration: calibration as NonNullable<
                Schemas["UploadSensorDataDto"]["calibration"]
              >,
            }
          : {}),
      },
    });
    return unwrap(result) as {
      accepted: number;
      segments_updated: number;
    };
  }

  /**
   * Submit sensor readings via the offline-aware queue (US-18 AC #4).
   * This is the ride-stop flow's entry point — the raw POST is kept
   * private so every caller goes through the queue. `modelVersion` is
   * the active on-device classifier (null = v0 RMS heuristic).
   * `tagEvents` are the rider-asserted surface labels captured during
   * the ride (research issue #7); pass an empty array when the rider
   * never tagged a surface. `calibration` is the idle-baseline
   * snapshot (issue #494); pass `null` when the calibration window
   * was abandoned mid-ride.
   */
  async submitSensorData(
    rideId: string,
    readings: SensorReading[],
    deviceModel: string,
    modelVersion: string | null,
    tagEvents: RideTagEvent[] = [],
    calibration: CalibrationPayload | null = null,
  ): Promise<SubmitResult> {
    return submitSensorUpload(
      rideId,
      readings,
      deviceModel,
      modelVersion,
      tagEvents,
      // Live submissions always carry the current build's preprocessing
      // marker — the filter is always-on in the production pipeline.
      // Replays of pre-#493 queued entries override this with the value
      // they were captured under (or `null` for raw axes); see
      // offlineQueue.PendingUpload.preprocessingVersion.
      SENSOR_PREPROCESSING_VERSION,
      calibration,
      (id, r, model, version, tags, preprocessing, cal) =>
        this.uploadSensorData(id, r, model, version, tags, preprocessing, cal),
    );
  }

  /**
   * Best-effort flush of any pending sensor uploads. Driven by the
   * Settings "Retry now" button and could be called by a future
   * connectivity watcher.
   */
  async flushPendingSensorUploads(): Promise<DrainResult> {
    return drainOfflineQueue(
      (id, r, model, version, tags, preprocessing, cal) =>
        this.uploadSensorData(id, r, model, version, tags, preprocessing, cal),
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
      params: {
        query: {
          lat,
          lng,
          radius,
          ...(minQuality !== undefined ? { min_quality: minQuality } : {}),
        },
      },
    });
    return unwrap(result);
  }

  async getRoadSegment(segmentId: string): Promise<RoadSegmentDetail> {
    const result = await client.GET("/api/v1/roads/{segmentId}", {
      params: { path: { segmentId } },
    });
    return unwrap(result);
  }

  async getFunZones(bbox: string): Promise<FunZone[]> {
    const result = await client.GET("/api/v1/roads/fun-zones", {
      params: { query: { bbox } },
    });
    return unwrap(result);
  }

  // ── Hazards ──

  async getHazards(
    lat: number,
    lng: number,
    radius = 10000,
    types?: string,
  ): Promise<Hazard[]> {
    const result = await client.GET("/api/v1/hazards", {
      params: {
        query: {
          lat,
          lng,
          radius,
          ...(types !== undefined ? { types } : {}),
        },
      },
    });
    return unwrap(result);
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
        ...(note !== undefined ? { note } : {}),
        ...(photoUrl !== undefined ? { photo_url: photoUrl } : {}),
      },
    });
    return unwrap(result);
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
    return unwrap(result);
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
    return unwrap(result);
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
    return unwrap(result);
  }

  // ── Trips ──

  async listTrips(status?: string): Promise<TripSummary[]> {
    const result = await client.GET("/api/v1/trips", {
      params: {
        query: {
          ...(status !== undefined
            ? {
                status: status as "active" | "completed" | "draft" | "planned",
              }
            : {}),
        },
      },
    });
    return unwrap(result);
  }

  /**
   * US-37 — list the rider's trip folders. Mobile groups the trips
   * list by folder for read-only display; folder CRUD ships companion-
   * only for v1.
   */
  async listTripFolders(): Promise<TripFolder[]> {
    const result = await client.GET("/api/v1/trip-folders");
    const body = unwrap(result) as {
      items?: TripFolder[];
    };
    return body.items ?? [];
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
    return unwrap(result);
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
    return unwrap(result);
  }

  async getTrip(tripId: string): Promise<Trip> {
    const result = await client.GET("/api/v1/trips/{tripId}", {
      params: { path: { tripId } },
    });
    return unwrap(result);
  }

  async deleteTrip(
    tripId: string,
    opts?: { onlyIfDraft?: boolean },
  ): Promise<void> {
    const result = await client.DELETE("/api/v1/trips/{tripId}", {
      params: {
        path: { tripId },
        // Atomic draft-only delete for orphan cleanup: the backend folds the
        // `status = 'draft'` predicate into the DELETE so a route that finished
        // generating in a post-commit race is never cascaded away.
        ...(opts?.onlyIfDraft ? { query: { onlyIfDraft: "true" } } : {}),
      },
    });
    unwrapVoid(result);
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
        ...(options.bbox !== undefined ? { bbox: options.bbox } : {}),
        ...(options.option !== undefined ? { option: options.option } : {}),
        ...(options.surfaces !== undefined
          ? {
              surfaces: options.surfaces as NonNullable<
                Schemas["GenerateTripDto"]["surfaces"]
              >,
            }
          : {}),
      },
    });
    return unwrap(result);
  }

  async joinTrip(tripId: string, inviteCode: string): Promise<void> {
    const result = await client.POST("/api/v1/trips/{tripId}/join", {
      params: { path: { tripId } },
      body: { invite_code: inviteCode },
    });
    unwrapVoid(result);
  }

  // ── Group Rides (US-26) ──

  async createGroupRide(name: string): Promise<GroupRideDetail> {
    const result = await client.POST("/api/v1/group-rides", {
      body: { name },
    });
    return unwrap(result);
  }

  async joinGroupRide(code: string): Promise<GroupRideDetail> {
    const result = await client.POST("/api/v1/group-rides/{code}/join", {
      params: { path: { code } },
    });
    return unwrap(result);
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
    return unwrap(result);
  }

  // ── Reviews ──

  async getReviews(segmentId: string): Promise<RoadReview[]> {
    const result = await client.GET("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId } },
    });
    return unwrap(result);
  }

  async submitReview(payload: ReviewSubmissionPayload): Promise<RoadReview> {
    const result = await client.POST("/api/v1/roads/{segmentId}/reviews", {
      params: { path: { segmentId: payload.segmentId } },
      body: {
        rating: payload.rating,
        ...(payload.comment != null ? { comment: payload.comment } : {}),
        ...(payload.bikeModel != null ? { bike_model: payload.bikeModel } : {}),
        ...(payload.photos != null ? { photos: payload.photos } : {}),
      },
    });
    return unwrap(result);
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
        ...(payload.comment != null ? { comment: payload.comment } : {}),
        ...(payload.bikeModel != null ? { bike_model: payload.bikeModel } : {}),
        ...(payload.photos != null ? { photos: payload.photos } : {}),
      },
    });
    return unwrap(result);
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
    return unwrap(result);
  }

  async voteOnReview(
    reviewId: string,
    isHelpful: boolean,
  ): Promise<ReviewVoteResult> {
    const result = await client.POST("/api/v1/roads/reviews/{reviewId}/vote", {
      params: { path: { reviewId } },
      body: { is_helpful: isHelpful },
    });
    return unwrap(result);
  }

  async clearReviewVote(reviewId: string): Promise<ReviewVoteResult> {
    const result = await client.DELETE(
      "/api/v1/roads/reviews/{reviewId}/vote",
      { params: { path: { reviewId } } },
    );
    return unwrap(result);
  }

  // ── Commute ──

  async getCommuteRoutes(): Promise<CommuteRoute[]> {
    const result = await client.GET("/api/v1/commute/routes");
    return unwrap(result);
  }

  async getCommuteStatus(): Promise<CommuteStatus> {
    const result = await client.GET("/api/v1/commute/status");
    return unwrap(result);
  }

  async getCommuteAlternatives(): Promise<CommuteAlternativesResponse> {
    const result = await client.GET("/api/v1/commute/alternatives");
    return unwrap(result);
  }

  async getCommuteStats(
    period: "week" | "month" = "week",
  ): Promise<CommuteStats> {
    const result = await client.GET("/api/v1/commute/stats", {
      params: { query: { period } },
    });
    return unwrap(result);
  }

  async setPrimaryCommuteRoute(routeId: string): Promise<CommuteRoute> {
    const result = await client.PUT(
      "/api/v1/commute/routes/{routeId}/primary",
      { params: { path: { routeId } } },
    );
    return unwrap(result);
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
    return unwrap(result);
  }

  // ── Mountain Passes (US-11) ──

  async getPasses(bbox?: string): Promise<MountainPass[]> {
    const pageSize = 500;
    const passes: MountainPass[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await client.GET("/api/v1/passes", {
        params: {
          query: {
            ...(bbox ? { bbox } : {}),
            limit: pageSize,
            offset,
          },
        },
      });
      const page = unwrap(result);
      passes.push(...page);
      if (page.length < pageSize) return passes;
    }
  }

  /**
   * The PUBLIC global limit-override map (`GET /config/limits`, no auth). Only
   * operator overrides appear; a missing key means the limit resolves normally.
   * The launch-mode source for anonymous surfaces (the road-quality overlay for
   * signed-out riders), where the auth-scoped `/users/me` snapshot never lands.
   */
  async getConfigLimits(): Promise<GlobalLimitOverrides> {
    const result = await client.GET("/api/v1/config/limits");
    return unwrap(result);
  }

  /**
   * The PUBLIC global operator system-switch override map (`GET /config/flags`,
   * no auth). Only operator overrides appear (`"force_off"` / `"force_on"`); a
   * missing key means the `sys_*` switch resolves to its default (ON). Backs the
   * client-side kill switches (e.g. `sys_accel_collection`).
   */
  async getConfigFlags(): Promise<GlobalFeatureStates> {
    const result = await client.GET("/api/v1/config/flags");
    return unwrap(result);
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
    return unwrap(result);
  }

  // ── POI / Accommodations (US-10) ──

  async listAccommodations(
    lat: number,
    lng: number,
    radiusKm?: number,
  ): Promise<AccommodationList> {
    const result = await client.GET("/api/v1/poi/accommodations", {
      params: {
        query: {
          lat,
          lng,
          ...(radiusKm !== undefined ? { radius_km: radiusKm } : {}),
        },
      },
    });
    return unwrap(result);
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
          ...(options.radiusKm !== undefined
            ? { radius_km: options.radiusKm }
            : {}),
          ...(options.kinds?.length ? { kinds: options.kinds } : {}),
        },
      },
    });
    return unwrap(result);
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
        ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
      },
    });
    return unwrap(result);
  }

  // ── Gamification: Badges (US-28) ──
  // `listUserBadges` is defined above alongside the rider-profile endpoints
  // — both this surface and ProfileScreen consume it.

  async checkBadges(): Promise<CheckBadgesResponse> {
    const result = await client.POST("/api/v1/badges/check");
    return unwrap(result);
  }

  // ── Gamification: Challenges (US-29) ──

  async listChallenges(): Promise<Challenge[]> {
    const result = await client.GET("/api/v1/challenges");
    return unwrap(result);
  }

  async getChallenge(challengeId: string): Promise<ChallengeDetail> {
    const result = await client.GET("/api/v1/challenges/{challengeId}", {
      params: { path: { challengeId } },
    });
    return unwrap(result);
  }

  async joinChallenge(challengeId: string): Promise<ChallengeJoinResponse> {
    const result = await client.POST("/api/v1/challenges/{challengeId}/join", {
      params: { path: { challengeId } },
    });
    return unwrap(result);
  }

  // ── Gamification: Exploration / Personal road map (US-30) ──

  async getExplorationStats(): Promise<ExplorationStats> {
    const result = await client.GET("/api/v1/exploration/stats");
    return unwrap(result);
  }

  async getRiddenSegments(): Promise<RiddenSegmentsList> {
    const result = await client.GET("/api/v1/exploration/ridden-segments");
    return unwrap(result);
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
          ...(options.radiusKm !== undefined
            ? { radius_km: options.radiusKm }
            : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        },
      },
    });
    return unwrap(result);
  }

  // ── Notification preferences ──

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    const result = await client.GET("/api/v1/me/notification-preferences");
    return unwrap(result);
  }

  async updateNotificationPreferences(
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const result = await client.PUT("/api/v1/me/notification-preferences", {
      body: patch as Schemas["UpdateNotificationPreferencesDto"],
    });
    return unwrap(result);
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
        ...(options.rideId !== undefined ? { ride_id: options.rideId } : {}),
        ...(options.speedAtImpact !== undefined
          ? { speed_at_impact: options.speedAtImpact }
          : {}),
        ...(options.severity !== undefined
          ? { severity: options.severity }
          : {}),
        ...(options.alertId !== undefined ? { alert_id: options.alertId } : {}),
        ...(options.locale !== undefined ? { locale: options.locale } : {}),
      },
    });
    return unwrap(result);
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

// Narrows the generated `BikeDto` schema (camelCase keys, optional
// nullables) into the local `Bike` interface so the chip caller
// doesn't have to deal with the optional / nullable bookkeeping at
// the read site.
function bikeFromSchema(b: Schemas["BikeDto"]): Bike {
  return {
    id: b.id,
    make: b.make,
    model: b.model,
    year: b.year ?? null,
    isActive: b.isActive,
    photoUrl: b.photoUrl ?? null,
    icon: b.icon ?? null,
    notes: b.notes ?? null,
    totalKm: b.totalKm,
    totalRides: b.totalRides,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export const api = new ApiService();
