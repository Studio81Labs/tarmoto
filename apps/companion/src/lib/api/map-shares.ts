import { apiFetch } from "./client";

// ── Map shares (US-50: read-only personal road-map snapshots) ──

export interface MapShareResponse {
  id: string;
  share_token: string;
  share_url: string;
  title: string;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface MapSharePublic {
  share_token: string;
  title: string;
  owner_name: string;
  snapshot: Record<string, unknown>;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export interface MapShareListResponse {
  items: MapShareResponse[];
  total: number;
}

export const mapSharesApi = {
  create: (payload: { title: string; snapshot: Record<string, unknown> }) =>
    apiFetch<MapShareResponse>("/map-shares", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMine: () => apiFetch<MapShareListResponse>("/map-shares/mine"),
  getByToken: (token: string) =>
    apiFetch<MapSharePublic>(`/map-shares/${encodeURIComponent(token)}`),
  revoke: (id: string) =>
    apiFetch(`/map-shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
