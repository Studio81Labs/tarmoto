import { createApiClient } from "@tarmoto/openapi/client";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";

// Typed openapi-fetch client for all spec-defined endpoints
export const api = createApiClient({
  baseUrl: API_HOST,
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().clearSession(),
});

// ── Auth helpers ──

export async function forgotPassword(email: string) {
  await apiFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// Used by the registration page before Auth.js signIn.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const { data } = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  return data;
}

// ── Raw fetch helper for endpoints not yet in the OpenAPI spec ──
// Checks res.ok and clears session on 401 (matching openapi-fetch client behavior).
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T }> {
  const token = useAuthStore.getState().accessToken;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers ?? {})),
  };
  const { headers: _, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().clearSession();
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string }).message ??
        `Request failed (${res.status})`,
    );
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { data: undefined as T };
  }
  const data = (await res.json()) as T;
  return { data };
}

// ── Trip endpoints (not yet in spec) ──
export const tripsApi = {
  list: (params?: { page?: number; status?: string }) => {
    const defined = params
      ? Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    const query = defined ? "?" + new URLSearchParams(defined).toString() : "";
    return apiFetch(`/trips${query}`);
  },
  get: (id: string) => apiFetch(`/trips/${id}`),
  create: (data: unknown) =>
    apiFetch("/trips", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: unknown) =>
    apiFetch(`/trips/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: string) => apiFetch(`/trips/${id}`, { method: "DELETE" }),
  generate: (params: unknown) =>
    apiFetch("/trips/generate", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  invite: (tripId: string, email: string) =>
    apiFetch(`/trips/${tripId}/invite`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
};

// ── Exploration endpoints (not yet in spec) ──
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

export const explorationApi = {
  getStats: () => apiFetch<ExplorationStats>("/exploration/stats"),
  getRiddenIds: () =>
    apiFetch<{ segment_ids: string[] }>("/exploration/ridden-ids"),
  getNearbyUnridden: (params: {
    lat: number;
    lng: number;
    radius_km?: number;
    limit?: number;
  }) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius_km != null)
      query.set("radius_km", String(params.radius_km));
    if (params.limit != null) query.set("limit", String(params.limit));
    return apiFetch<UnriddenSegment[]>(
      `/exploration/nearby-unridden?${query.toString()}`,
    );
  },
};

// ── Account endpoints (not yet in spec) ──
export const accountApi = {
  updateProfile: (data: unknown) =>
    apiFetch("/account/profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getSubscription: () => apiFetch("/account/subscription"),
  getBikes: () => apiFetch("/account/bikes"),
  addBike: (data: unknown) =>
    apiFetch("/account/bikes", { method: "POST", body: JSON.stringify(data) }),
  updateBike: (id: string, data: unknown) =>
    apiFetch(`/account/bikes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBike: (id: string) =>
    apiFetch(`/account/bikes/${id}`, { method: "DELETE" }),
  exportData: () => apiFetch("/account/export", { method: "POST" }),
  deleteAccount: () => apiFetch("/account", { method: "DELETE" }),
  getNotificationPreferences: () =>
    apiFetch("/account/notification-preferences"),
  updateNotificationPreferences: (data: unknown) =>
    apiFetch("/account/notification-preferences", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getPrivacySettings: () => apiFetch("/account/privacy-settings"),
  updatePrivacySettings: (data: unknown) =>
    apiFetch("/account/privacy-settings", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};
