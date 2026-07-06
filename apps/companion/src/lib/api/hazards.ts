import { apiFetch } from "./client";

// ── Hazards endpoints (public; transitional raw helper, follow-up #861) ──

export interface HazardResponse {
  id: string;
  lat: number;
  lng: number;
  hazard_type: string;
  severity: string;
  note: string | null;
  /** Public URL of the rider-attached photo, when present. */
  photo_url: string | null;
  confirmations: number;
  reporter: string | null;
  road_name: string | null;
  created_at: string;
  expires_at: string;
}

export const hazardsApi = {
  findNearby: (
    params: { lat: number; lng: number; radius?: number; types?: string },
    init?: RequestInit,
  ) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius != null) query.set("radius", String(params.radius));
    if (params.types) query.set("types", params.types);
    return apiFetch<HazardResponse[]>(`/hazards?${query.toString()}`, init);
  },
};
