import { apiFetch } from "./client";

// ── Closures endpoints (US-40 seasonal closures & roadworks) ──

export type RoadClosureReason =
  | "closure"
  | "roadworks"
  | "seasonal"
  | "weather"
  | "event"
  | "other";

export type RoadClosureSeverity = "advisory" | "partial" | "full";

export interface RoadClosurePoint {
  lat: number;
  lng: number;
}

export interface RoadClosure {
  id: string;
  title: string;
  reason: RoadClosureReason;
  severity: RoadClosureSeverity;
  geometry: RoadClosurePoint[];
  detour: RoadClosurePoint[] | null;
  country_code: string;
  region: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  source: "operator" | "osm" | "official";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckRouteClosuresResponse {
  closures: RoadClosure[];
  full_count: number;
  partial_count: number;
  advisory_count: number;
}

export const closuresApi = {
  list: (
    params: {
      bbox?: string;
      active_on?: string;
      severity?: RoadClosureSeverity;
      reason?: RoadClosureReason;
      include_past?: boolean;
    },
    init?: RequestInit,
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") query.set(key, String(value));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiFetch<RoadClosure[]>(`/closures${suffix}`, init);
  },
  checkRoute: (
    data: {
      route: RoadClosurePoint[];
      buffer_m?: number;
      active_on?: string;
    },
    init?: RequestInit,
  ) =>
    apiFetch<CheckRouteClosuresResponse>("/closures/check-route", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
};
