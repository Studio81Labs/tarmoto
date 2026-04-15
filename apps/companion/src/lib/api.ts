import { createApiClient } from "@tarmoto/openapi/client";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";

// Typed openapi-fetch client for all spec-defined endpoints
export const api = createApiClient({
  baseUrl: API_HOST,
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().clearSession(),
});

// ── Register endpoint ──
// Used by the registration page before Auth.js signIn.
// This stays as raw fetch since registration is handled outside the normal API flow.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, display_name: displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message ?? "Registration failed");
  }
  return res.json();
}

// ── Raw fetch helper for endpoints not yet in the OpenAPI spec ──
// Checks res.ok and clears session on 401 (matching openapi-fetch client behavior).
async function apiFetch<T>(path: string, init?: RequestInit): Promise<{ data: T }> {
  const token = useAuthStore.getState().accessToken;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : init?.headers ?? {}),
  };
  const { headers: _, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().clearSession();
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { data: undefined as T };
  }
  const data = await res.json() as T;
  return { data };
}

// ── Trip endpoints (not yet in spec) ──
export const tripsApi = {
  list: (params?: { page?: number; status?: string }) => {
    const defined = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
      : undefined;
    const query = defined ? "?" + new URLSearchParams(defined).toString() : "";
    return apiFetch(`/trips${query}`);
  },
  get: (id: string) => apiFetch(`/trips/${id}`),
  create: (data: unknown) => apiFetch("/trips", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: unknown) => apiFetch(`/trips/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: string) => apiFetch(`/trips/${id}`, { method: "DELETE" }),
  generate: (params: unknown) => apiFetch("/trips/generate", { method: "POST", body: JSON.stringify(params) }),
  invite: (tripId: string, email: string) => apiFetch(`/trips/${tripId}/invite`, { method: "POST", body: JSON.stringify({ email }) }),
};

// ── Account endpoints (not yet in spec) ──
export const accountApi = {
  updateProfile: (data: unknown) => apiFetch("/account/profile", { method: "PATCH", body: JSON.stringify(data) }),
  getSubscription: () => apiFetch("/account/subscription"),
  getBikes: () => apiFetch("/account/bikes"),
  addBike: (data: unknown) => apiFetch("/account/bikes", { method: "POST", body: JSON.stringify(data) }),
  updateBike: (id: string, data: unknown) => apiFetch(`/account/bikes/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteBike: (id: string) => apiFetch(`/account/bikes/${id}`, { method: "DELETE" }),
  exportData: () => apiFetch("/account/export", { method: "POST" }),
  deleteAccount: () => apiFetch("/account", { method: "DELETE" }),
};
