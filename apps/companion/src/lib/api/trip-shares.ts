import { apiFetch } from "./client";

// ── Trip shares (US-35: read-only invite links, first slice) ──

export interface TripShareResponse {
  id: string;
  share_token: string;
  share_url: string;
  trip_id: string | null;
  title: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface TripSharePublic {
  share_token: string;
  trip_id: string | null;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface TripShareListResponse {
  items: TripShareResponse[];
  total: number;
}

export interface TripShareJoinResponse {
  trip_id: string;
  planner_url: string;
}

export const tripSharesApi = {
  create: (payload: {
    title: string;
    snapshot: Record<string, unknown>;
    trip_id?: string | null;
  }) =>
    apiFetch<TripShareResponse>("/trip-shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMine: () => apiFetch<TripShareListResponse>("/trip-shares/mine"),
  getByToken: (token: string) =>
    apiFetch<TripSharePublic>(`/trip-shares/${encodeURIComponent(token)}`),
  joinByToken: (token: string) =>
    apiFetch<TripShareJoinResponse>(
      `/trip-shares/${encodeURIComponent(token)}/join`,
      { method: "POST" },
    ),
  revoke: (id: string) =>
    apiFetch(`/trip-shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
