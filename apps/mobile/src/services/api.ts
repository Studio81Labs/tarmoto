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
  RideSummary,
  RideDetail,
  RoadSegment,
  RoadSegmentDetail,
  FunZone,
  Hazard,
  HazardType,
  Severity,
  Trip,
  TripSummary,
  CommuteRoute,
  CommuteStatus,
  CalculatedRoute,
  RoutePreferences,
  LatLng,
  RoadReview,
  MountainPass,
  CheckRouteForPassesResponse,
  SensorReading,
  AccommodationList,
  PoiKind,
  PoiList,
} from "@/types";
import {
  drainOfflineQueue,
  submitSensorUpload,
  type DrainResult,
  type SubmitResult,
} from "./offlineQueue";

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
  ): Promise<{ accepted: number; segments_updated: number }> {
    const { data } = await this.client.post("/sensor/upload", {
      ride_id: rideId,
      device_model: deviceModel,
      readings,
    });
    return data;
  }

  /**
   * Submit sensor readings via the offline-aware queue (US-18 AC #4).
   * This is the ride-stop flow's entry point — the raw POST is kept
   * private so every caller goes through the queue.
   */
  async submitSensorData(
    rideId: string,
    readings: SensorReading[],
    deviceModel: string,
  ): Promise<SubmitResult> {
    return submitSensorUpload(rideId, readings, deviceModel, (id, r, model) =>
      this.uploadSensorData(id, r, model),
    );
  }

  /**
   * Best-effort flush of any pending sensor uploads. Driven by the
   * Settings "Retry now" button and could be called by a future
   * connectivity watcher.
   */
  async flushPendingSensorUploads(): Promise<DrainResult> {
    return drainOfflineQueue((id, r, model) =>
      this.uploadSensorData(id, r, model),
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

  async getTrip(tripId: string): Promise<Trip> {
    const { data } = await this.client.get<Trip>(`/trips/${tripId}`);
    return data;
  }

  async generateTripRoute(
    tripId: string,
    startLocation: LatLng,
    bbox: string,
  ): Promise<Trip> {
    const { data } = await this.client.post<Trip>(`/trips/${tripId}/generate`, {
      start_location: startLocation,
      bbox,
    });
    return data;
  }

  async joinTrip(tripId: string, inviteCode: string): Promise<void> {
    await this.client.post(`/trips/${tripId}/join`, {
      invite_code: inviteCode,
    });
  }

  // ── Reviews ──

  async getReviews(segmentId: string): Promise<RoadReview[]> {
    const { data } = await this.client.get<RoadReview[]>(
      `/roads/${segmentId}/reviews`,
    );
    return data;
  }

  async submitReview(
    segmentId: string,
    rating: number,
    comment?: string,
    bikeModel?: string,
  ): Promise<RoadReview> {
    const { data } = await this.client.post<RoadReview>(
      `/roads/${segmentId}/reviews`,
      { rating, comment, bike_model: bikeModel },
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

  // ── Safety ──

  async sendCrashAlert(
    lat: number,
    lng: number,
    rideId?: string,
    speedAtImpact?: number,
  ): Promise<void> {
    await this.client.post("/safety/crash-alert", {
      lat,
      lng,
      ride_id: rideId,
      speed_at_impact: speedAtImpact,
    });
  }
}

export const api = new ApiService();
