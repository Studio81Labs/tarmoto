import { createApiClient } from "@tarmoto/openapi/client";
import { useAuthStore } from "@/stores/auth";

// baseUrl is the host only — spec paths already include /api/v1
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

// Typed openapi-fetch client for all spec-defined endpoints
export const api = createApiClient({
  baseUrl: API_BASE,
  getToken: () => useAuthStore.getState().accessToken,
});

// ── Register endpoint ──
// Used by the registration page before Auth.js signIn.
// This stays as raw fetch since registration is handled outside the normal API flow.
export async function registerUser(
  email: string,
  password: string,
  displayName: string,
) {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
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

// ── Trip endpoints ──
// Trips are not yet in the OpenAPI spec — using raw fetch until they are added.
const getAuthHeaders = (): HeadersInit => {
  const token = useAuthStore.getState().accessToken;
  return token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" };
};

export const tripsApi = {
  list: (params?: { page?: number; status?: string }) => {
    const query = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return fetch(`${API_BASE}/api/v1/trips${query}`, { headers: getAuthHeaders() }).then((r) => r.json().then((data) => ({ data })));
  },
  get: (id: string) =>
    fetch(`${API_BASE}/api/v1/trips/${id}`, { headers: getAuthHeaders() }).then((r) => r.json().then((data) => ({ data }))),
  create: (data: unknown) =>
    fetch(`${API_BASE}/api/v1/trips`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify(data) }).then((r) => r.json().then((d) => ({ data: d }))),
  update: (id: string, data: unknown) =>
    fetch(`${API_BASE}/api/v1/trips/${id}`, { method: "PATCH", headers: getAuthHeaders(), body: JSON.stringify(data) }).then((r) => r.json().then((d) => ({ data: d }))),
  delete: (id: string) =>
    fetch(`${API_BASE}/api/v1/trips/${id}`, { method: "DELETE", headers: getAuthHeaders() }),
  generate: (params: unknown) =>
    fetch(`${API_BASE}/api/v1/trips/generate`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify(params) }).then((r) => r.json().then((data) => ({ data }))),
  invite: (tripId: string, email: string) =>
    fetch(`${API_BASE}/api/v1/trips/${tripId}/invite`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify({ email }) }).then((r) => r.json().then((data) => ({ data }))),
};

// ── Account endpoints ──
// Account bikes are not yet in the OpenAPI spec — using raw fetch until they are added.
export const accountApi = {
  updateProfile: (data: unknown) =>
    fetch(`${API_BASE}/api/v1/account/profile`, { method: "PATCH", headers: getAuthHeaders(), body: JSON.stringify(data) }).then((r) => r.json().then((d) => ({ data: d }))),
  getSubscription: () =>
    fetch(`${API_BASE}/api/v1/account/subscription`, { headers: getAuthHeaders() }).then((r) => r.json().then((data) => ({ data }))),
  getBikes: () =>
    fetch(`${API_BASE}/api/v1/account/bikes`, { headers: getAuthHeaders() }).then((r) => r.json().then((data) => ({ data }))),
  addBike: (data: unknown) =>
    fetch(`${API_BASE}/api/v1/account/bikes`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify(data) }).then((r) => r.json().then((d) => ({ data: d }))),
  updateBike: (id: string, data: unknown) =>
    fetch(`${API_BASE}/api/v1/account/bikes/${id}`, { method: "PATCH", headers: getAuthHeaders(), body: JSON.stringify(data) }).then((r) => r.json().then((d) => ({ data: d }))),
  deleteBike: (id: string) =>
    fetch(`${API_BASE}/api/v1/account/bikes/${id}`, { method: "DELETE", headers: getAuthHeaders() }),
  exportData: () =>
    fetch(`${API_BASE}/api/v1/account/export`, { method: "POST", headers: getAuthHeaders() }).then((r) => r.json().then((data) => ({ data }))),
  deleteAccount: () =>
    fetch(`${API_BASE}/api/v1/account`, { method: "DELETE", headers: getAuthHeaders() }),
};
