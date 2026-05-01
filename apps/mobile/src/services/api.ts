/**
 * Tarmoto API Service
 * Axios-based client for the NestJS backend.
 * Auto-attaches JWT tokens and handles refresh.
 */

import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { createMMKV } from "react-native-mmkv";
import { API_BASE_URL } from "@/config";
import type {
  AuthResponse,
  User,
  PublicProfile,
  FollowerListItem,
  UserBadge,
  RideSummary,
  RideDetail,
  RoadSegment,
  RoadSegmentDetail,
  FunZone,
  Hazard,
  HazardType,
  Severity,
  Trip,
  TripGenerationOptionId,
  TripGenerationResult,
  TripSummary,
  CommuteRoute,
  CommuteStatus,
  CommuteAlternativesResponse,
  CommuteStats,
  RouteWeatherResponse,
  CalculatedRoute,
  RoutePreferences,
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
  ChallengeProgress,
  ExplorationStats,
  RiddenSegmentIds,
  RiddenSegmentsList,
  UnriddenSegment,
} from "@/types";
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

const storage = createMMKV({ id: "tarmoto-auth" });

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    // Attach auth token
    this.client.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        const token = storage.getString("access_token");
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
    );

    // Handle 401 → refresh
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          const refreshed = await this.refreshToken();
          if (refreshed && error.config) {
            return this.client.request(error.config);
          }
        }
        return Promise.reject(error);
      },
    );
  }

  // ── Auth ──

  async register(
    email: string,
    password: string,
    display_name: string,
  ): Promise<AuthResponse> {
    const { data } = await this.client.post<AuthResponse>("/auth/register", {
      email,
      password,
      display_name,
    });
    this.storeTokens(data);
    return data;
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const { data } = await this.client.post<AuthResponse>("/auth/login", {
      email,
      password,
    });
    this.storeTokens(data);
    return data;
  }

  async refreshToken(): Promise<boolean> {
    const refreshToken = storage.getString("refresh_token");
    if (!refreshToken) return false;
    try {
      const { data } = await this.client.post<AuthResponse>("/auth/refresh", {
        refresh_token: refreshToken,
      });
      this.storeTokens(data);
      return true;
    } catch {
      this.clearTokens();
      return false;
    }
  }

  logout(): void {
    this.clearTokens();
  }

  private storeTokens(auth: AuthResponse): void {
    storage.set("access_token", auth.access_token);
    storage.set("refresh_token", auth.refresh_token);
  }

  private clearTokens(): void {
    storage.remove("access_token");
    storage.remove("refresh_token");
  }

  isAuthenticated(): boolean {
    return !!storage.getString("access_token");
  }

  // ── Users ──

  async getProfile(): Promise<User> {
    const { data } = await this.client.get<User>("/users/me");
    return data;
  }

  async updateProfile(updates: Partial<User>): Promise<User> {
    const { data } = await this.client.patch<User>("/users/me", updates);
    return data;
  }

  // ── Rider profiles + follow (US-27) ──

  /**
   * Fetch a rider's public profile (display fields + follower/following
   * counts + viewer's `is_following` flag). Powers both the own-profile
   * stats row and the read-only ViewProfile screen so a single endpoint
   * covers both modes.
   */
  async getPublicProfile(userId: string): Promise<PublicProfile> {
    const { data } = await this.client.get<PublicProfile>(
      `/users/${userId}/profile`,
    );
    return data;
  }

  async followUser(userId: string): Promise<void> {
    await this.client.post(`/users/${userId}/follow`);
  }

  async unfollowUser(userId: string): Promise<void> {
    await this.client.delete(`/users/${userId}/follow`);
  }

  async listFollowers(userId: string): Promise<FollowerListItem[]> {
    const { data } = await this.client.get<FollowerListItem[]>(
      `/users/${userId}/followers`,
    );
    return data;
  }

  async listFollowing(userId: string): Promise<FollowerListItem[]> {
    const { data } = await this.client.get<FollowerListItem[]>(
      `/users/${userId}/following`,
    );
    return data;
  }

  async listUserBadges(userId: string): Promise<UserBadge[]> {
    const { data } = await this.client.get<UserBadge[]>(
      `/users/${userId}/badges`,
    );
    return data;
  }

  /**
   * Upload a new avatar. Mirrors the multipart pattern used by review photo
   * upload — the instance-level `Content-Type: application/json` header
   * must be cleared so axios's FormData transform can set the correct
   * `multipart/form-data; boundary=...` value (Multer rejects requests
   * without the boundary).
   */
  async uploadAvatar(photo: {
    uri: string;
    mimeType?: string;
    fileName?: string;
  }): Promise<User> {
    const form = new FormData();
    form.append("file", {
      uri: photo.uri,
      type: photo.mimeType ?? "image/jpeg",
      name: photo.fileName ?? `avatar-${Date.now()}.jpg`,
    } as unknown as Blob);
    const { data } = await this.client.post<User>("/users/me/avatar", form, {
      headers: {
        "Content-Type": undefined as unknown as string,
      },
    });
    return data;
  }

  // ── Emergency Contacts (US-12) ──

  async listContacts(): Promise<EmergencyContact[]> {
    const { data } =
      await this.client.get<EmergencyContact[]>("/users/me/contacts");
    return data;
  }

  async addContact(input: EmergencyContactInput): Promise<EmergencyContact> {
    const { data } = await this.client.post<EmergencyContact>(
      "/users/me/contacts",
      input,
    );
    return data;
  }

  async updateContact(
    contactId: string,
    input: Partial<EmergencyContactInput>,
  ): Promise<EmergencyContact> {
    const { data } = await this.client.patch<EmergencyContact>(
      `/users/me/contacts/${contactId}`,
      input,
    );
    return data;
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.client.delete(`/users/me/contacts/${contactId}`);
  }

  // ── Rides ──

  async startRide(
    type: string = "free",
    tripDayId?: string,
  ): Promise<RideDetail> {
    const { data } = await this.client.post<RideDetail>("/rides/start", {
      ride_type: type,
      trip_day_id: tripDayId,
    });
    return data;
  }

  async stopRide(rideId: string): Promise<RideDetail> {
    const { data } = await this.client.post<RideDetail>(
      `/rides/${rideId}/stop`,
    );
    return data;
  }

  async getRide(rideId: string): Promise<RideDetail> {
    const { data } = await this.client.get<RideDetail>(`/rides/${rideId}`);
    return data;
  }

  async listRides(
    limit = 20,
    offset = 0,
    type?: string,
  ): Promise<{ rides: RideSummary[]; total: number }> {
    const { data } = await this.client.get("/rides", {
      params: { limit, offset, type },
    });
    return data;
  }

  /**
   * Fetch a ride's GPX export as raw XML text. Used by RideDetailScreen's
   * share / export button — the bytes are written to a local file and
   * handed to the system share sheet so the rider can forward to any GPX
   * consumer (Garmin, Komoot, etc.).
   */
  async exportRideGpx(rideId: string): Promise<string> {
    const { data } = await this.client.get<string>(`/rides/${rideId}/gpx`, {
      responseType: "text",
      // Override the JSON default so axios doesn't try to parse the
      // GPX/XML body and end up with `[object Object]`.
      headers: { Accept: "application/gpx+xml" },
    });
    return data;
  }

  /**
   * Bulk-export every ride owned by the caller as a single GPX bundle.
   * Backend route: `GET /rides/export.gpx`. Used by the SettingsScreen
   * "Export all rides" action so riders can move their full history to
   * Garmin/RideWithGPS without writing a script.
   */
  async exportAllRidesGpx(): Promise<string> {
    const { data } = await this.client.get<string>("/rides/export.gpx", {
      responseType: "text",
      headers: { Accept: "application/gpx+xml" },
    });
    return data;
  }

  /**
   * Bulk-export the rider's ride history as a tabular CSV (one row per
   * ride). Useful for spreadsheet workflows / fitness analytics tools
   * that don't speak GPX.
   */
  async exportAllRidesCsv(): Promise<string> {
    const { data } = await this.client.get<string>("/rides/export.csv", {
      responseType: "text",
      headers: { Accept: "text/csv" },
    });
    return data;
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
    const { data } = await this.client.post("/sensor/upload", {
      ride_id: rideId,
      device_model: deviceModel,
      // Telemetry: which on-device classifier was active during this
      // batch (US-3). Omit when the mobile fallback heuristic ran —
      // backend treats missing as "no client model on that device".
      // The backend re-derives `classification` / `surface_type`
      // from raw readings regardless, so this never feeds the labels.
      client_model_version: modelVersion ?? undefined,
      readings,
    });
    return data;
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
    const { data } = await this.client.get<RoadSegment[]>("/roads/nearby", {
      params: { lat, lng, radius, min_quality: minQuality },
    });
    return data;
  }

  async getRoadSegment(segmentId: string): Promise<RoadSegmentDetail> {
    const { data } = await this.client.get<RoadSegmentDetail>(
      `/roads/${segmentId}`,
    );
    return data;
  }

  async getFunZones(bbox: string): Promise<FunZone[]> {
    const { data } = await this.client.get<FunZone[]>("/roads/fun-zones", {
      params: { bbox },
    });
    return data;
  }

  async calculateRoute(
    waypoints: LatLng[],
    preferences: RoutePreferences,
  ): Promise<CalculatedRoute> {
    const { data } = await this.client.post<CalculatedRoute>(
      "/route/calculate",
      { waypoints, preferences },
    );
    return data;
  }

  // ── Hazards ──

  async getHazards(
    lat: number,
    lng: number,
    radius = 10000,
    types?: string,
  ): Promise<Hazard[]> {
    const { data } = await this.client.get<Hazard[]>("/hazards", {
      params: { lat, lng, radius, types },
    });
    return data;
  }

  async reportHazard(
    lat: number,
    lng: number,
    type: HazardType,
    severity: Severity = "medium",
    note?: string,
  ): Promise<Hazard> {
    const { data } = await this.client.post<Hazard>("/hazards", {
      lat,
      lng,
      hazard_type: type,
      severity,
      note,
    });
    return data;
  }

  /**
   * Submit a hazard report through the offline-aware queue (US-4 AC #6).
   * `reportHazard` stays public for the existing call sites that want
   * the raw POST semantics, but every UI flow should funnel through
   * this method so a tunnel-time tap doesn't drop the report.
   *
   * The optional `photoUri` is preserved on queued entries so a future
   * drain can ship the attachment once the backend file-upload endpoint
   * lands; today's POST ignores it.
   */
  async submitHazardReport(
    payload: HazardReportPayload,
  ): Promise<SubmitHazardResult> {
    return submitHazardReport(payload, (p) =>
      this.reportHazard(p.lat, p.lng, p.hazardType, p.severity, p.note),
    );
  }

  /** Best-effort flush of any queued hazard reports. */
  async flushPendingHazardReports(): Promise<DrainHazardResult> {
    return drainHazardQueue((p) =>
      this.reportHazard(p.lat, p.lng, p.hazardType, p.severity, p.note),
    );
  }

  async confirmHazard(hazardId: string): Promise<Hazard> {
    const { data } = await this.client.post<Hazard>(
      `/hazards/${hazardId}/confirm`,
    );
    return data;
  }

  async dismissHazard(hazardId: string): Promise<void> {
    await this.client.post(`/hazards/${hazardId}/dismiss`);
  }

  async getHazardsAlongRoute(
    route: LatLng[],
    bufferM = 200,
  ): Promise<Hazard[]> {
    const { data } = await this.client.post<Hazard[]>("/hazards/route", {
      route,
      buffer_m: bufferM,
    });
    return data;
  }

  // ── Trips ──

  async listTrips(status?: string): Promise<TripSummary[]> {
    const { data } = await this.client.get<TripSummary[]>("/trips", {
      params: { status },
    });
    return data;
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
    const { data } = await this.client.post<Trip>("/trips", params);
    return data;
  }

  /**
   * Create a trip seeded from a parsed GPX/KML file (US-20). The mobile
   * app parses the file via `@tarmoto/shared` and posts the normalised
   * geometry + waypoints; the backend persists a single planned day with
   * the supplied geometry rather than running the route generator.
   */
  async importTripFromRoute(params: {
    title: string;
    region?: string;
    source_format: "gpx" | "kml";
    geometry: Array<{ lat: number; lng: number }>;
    waypoints?: Array<{ lat: number; lng: number; name?: string }>;
  }): Promise<Trip> {
    const { data } = await this.client.post<Trip>("/trips/import", params);
    return data;
  }

  async getTrip(tripId: string): Promise<Trip> {
    const { data } = await this.client.get<Trip>(`/trips/${tripId}`);
    return data;
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
    const { data } = await this.client.post<TripGenerationResult>(
      `/trips/${tripId}/generate`,
      {
        start_location: startLocation,
        ...options,
      },
    );
    return data;
  }

  async joinTrip(tripId: string, inviteCode: string): Promise<void> {
    await this.client.post(`/trips/${tripId}/join`, {
      invite_code: inviteCode,
    });
  }

  // ── Group Rides (US-26) ──

  async createGroupRide(name: string): Promise<GroupRideDetail> {
    const { data } = await this.client.post<GroupRideDetail>("/group-rides", {
      name,
    });
    return data;
  }

  async joinGroupRide(code: string): Promise<GroupRideDetail> {
    const { data } = await this.client.post<GroupRideDetail>(
      `/group-rides/${encodeURIComponent(code)}/join`,
    );
    return data;
  }

  async leaveGroupRide(groupRideId: string): Promise<void> {
    await this.client.post(`/group-rides/${groupRideId}/leave`);
  }

  async endGroupRide(groupRideId: string): Promise<void> {
    await this.client.post(`/group-rides/${groupRideId}/end`);
  }

  async getGroupRide(groupRideId: string): Promise<GroupRideDetail> {
    const { data } = await this.client.get<GroupRideDetail>(
      `/group-rides/${groupRideId}`,
    );
    return data;
  }

  // ── Reviews ──

  async getReviews(segmentId: string): Promise<RoadReview[]> {
    const { data } = await this.client.get<RoadReview[]>(
      `/roads/${segmentId}/reviews`,
    );
    return data;
  }

  async submitReview(payload: ReviewSubmissionPayload): Promise<RoadReview> {
    const { data } = await this.client.post<RoadReview>(
      `/roads/${payload.segmentId}/reviews`,
      {
        rating: payload.rating,
        comment: payload.comment,
        bike_model: payload.bikeModel,
        photos: payload.photos,
      },
    );
    return data;
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
    const { data } = await this.client.put<RoadReview>(
      `/roads/${payload.segmentId}/reviews`,
      {
        rating: payload.rating,
        comment: payload.comment,
        bike_model: payload.bikeModel,
        photos: payload.photos,
      },
    );
    return data;
  }

  async deleteReview(segmentId: string): Promise<void> {
    await this.client.delete(`/roads/${segmentId}/reviews`);
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
    // Clear the instance-level `Content-Type: application/json`
    // default for THIS request. Axios's FormData transform then sets
    // `multipart/form-data; boundary=...` correctly via the platform.
    // Hard-coding the bare value (without a boundary) makes Multer
    // reject the request with 400 even though capture succeeded —
    // the boundary is non-optional in RFC 7578 and the platform is
    // the only thing that can generate it.
    const { data } = await this.client.post<{ photos: string[] }>(
      `/roads/${segmentId}/reviews/photos`,
      form,
      {
        headers: {
          // Explicit-undefined removes the instance default from the
          // merged headers; cast required because the TS types model
          // header values as `string | number | boolean`.
          "Content-Type": undefined as unknown as string,
        },
        signal: options?.signal,
      },
    );
    return data;
  }

  async voteOnReview(
    reviewId: string,
    isHelpful: boolean,
  ): Promise<ReviewVoteResult> {
    const { data } = await this.client.post<ReviewVoteResult>(
      `/roads/reviews/${reviewId}/vote`,
      { is_helpful: isHelpful },
    );
    return data;
  }

  async clearReviewVote(reviewId: string): Promise<ReviewVoteResult> {
    const { data } = await this.client.delete<ReviewVoteResult>(
      `/roads/reviews/${reviewId}/vote`,
    );
    return data;
  }

  // ── Commute ──

  async getCommuteRoutes(): Promise<CommuteRoute[]> {
    const { data } = await this.client.get<CommuteRoute[]>("/commute/routes");
    return data;
  }

  async getCommuteStatus(): Promise<CommuteStatus> {
    const { data } = await this.client.get<CommuteStatus>("/commute/status");
    return data;
  }

  async getCommuteAlternatives(): Promise<CommuteAlternativesResponse> {
    const { data } = await this.client.get<CommuteAlternativesResponse>(
      "/commute/alternatives",
    );
    return data;
  }

  async getCommuteStats(
    period: "week" | "month" = "week",
  ): Promise<CommuteStats> {
    const { data } = await this.client.get<CommuteStats>("/commute/stats", {
      params: { period },
    });
    return data;
  }

  async setPrimaryCommuteRoute(routeId: string): Promise<CommuteRoute> {
    const { data } = await this.client.put<CommuteRoute>(
      `/commute/routes/${routeId}/primary`,
    );
    return data;
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
    const { data } = await this.client.post<RouteWeatherResponse>(
      "/weather/route",
      { route },
    );
    return data;
  }

  // ── Mountain Passes (US-11) ──

  async getPasses(bbox?: string): Promise<MountainPass[]> {
    const { data } = await this.client.get<MountainPass[]>("/passes", {
      params: bbox ? { bbox } : undefined,
    });
    return data;
  }

  async checkRouteForPasses(
    route: LatLng[],
    bufferM?: number,
  ): Promise<CheckRouteForPassesResponse> {
    const { data } = await this.client.post<CheckRouteForPassesResponse>(
      "/passes/check-route",
      { route, buffer_m: bufferM },
    );
    return data;
  }

  // ── POI / Accommodations (US-10) ──

  async listAccommodations(
    lat: number,
    lng: number,
    radiusKm?: number,
  ): Promise<AccommodationList> {
    const { data } = await this.client.get<AccommodationList>(
      "/poi/accommodations",
      {
        params: { lat, lng, radius_km: radiusKm },
      },
    );
    return data;
  }

  async listPois(
    lat: number,
    lng: number,
    options: { radiusKm?: number; kinds?: PoiKind[] } = {},
  ): Promise<PoiList> {
    const { data } = await this.client.get<PoiList>("/poi/nearby", {
      params: {
        lat,
        lng,
        radius_km: options.radiusKm,
        // Send kinds as a comma-separated list; the backend DTO
        // accepts both that form and repeated params.
        kinds: options.kinds?.length ? options.kinds.join(",") : undefined,
      },
    });
    return data;
  }

  async listPoisAlongRoute(
    route: LatLng[],
    options: { bufferKm?: number; kinds?: PoiKind[] } = {},
  ): Promise<AlongRoutePoiList> {
    const { data } = await this.client.post<AlongRoutePoiList>(
      "/poi/along-route",
      {
        route,
        buffer_km: options.bufferKm,
        kinds: options.kinds,
      },
    );
    return data;
  }

  // ── Gamification: Badges (US-28) ──
  // `listUserBadges` is defined above alongside the rider-profile endpoints
  // — both this surface and ProfileScreen consume it.

  async checkBadges(): Promise<CheckBadgesResponse> {
    const { data } =
      await this.client.post<CheckBadgesResponse>("/badges/check");
    return data;
  }

  // ── Gamification: Challenges (US-29) ──

  async listChallenges(): Promise<Challenge[]> {
    const { data } = await this.client.get<Challenge[]>("/challenges");
    return data;
  }

  async getChallenge(challengeId: string): Promise<ChallengeDetail> {
    const { data } = await this.client.get<ChallengeDetail>(
      `/challenges/${challengeId}`,
    );
    return data;
  }

  async joinChallenge(challengeId: string): Promise<ChallengeJoinResponse> {
    const { data } = await this.client.post<ChallengeJoinResponse>(
      `/challenges/${challengeId}/join`,
    );
    return data;
  }

  async getChallengeProgress(challengeId: string): Promise<ChallengeProgress> {
    const { data } = await this.client.get<ChallengeProgress>(
      `/challenges/${challengeId}/progress`,
    );
    return data;
  }

  // ── Gamification: Exploration / Personal road map (US-30) ──

  async getExplorationStats(): Promise<ExplorationStats> {
    const { data } =
      await this.client.get<ExplorationStats>("/exploration/stats");
    return data;
  }

  async getRiddenSegmentIds(): Promise<RiddenSegmentIds> {
    const { data } = await this.client.get<RiddenSegmentIds>(
      "/exploration/ridden-ids",
    );
    return data;
  }

  async getRiddenSegments(): Promise<RiddenSegmentsList> {
    const { data } = await this.client.get<RiddenSegmentsList>(
      "/exploration/ridden-segments",
    );
    return data;
  }

  async getNearbyUnriddenSegments(
    lat: number,
    lng: number,
    options: { radiusKm?: number; limit?: number } = {},
  ): Promise<UnriddenSegment[]> {
    const { data } = await this.client.get<UnriddenSegment[]>(
      "/exploration/nearby-unridden",
      {
        params: {
          lat,
          lng,
          radius_km: options.radiusKm,
          limit: options.limit,
        },
      },
    );
    return data;
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
    const { data } = await this.client.post<CrashAlertResponse>(
      "/safety/crash-alert",
      {
        lat,
        lng,
        ride_id: options.rideId,
        speed_at_impact: options.speedAtImpact,
        severity: options.severity,
        alert_id: options.alertId,
        locale: options.locale,
      },
    );
    return data;
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
