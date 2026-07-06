import type { MountainPass } from "@/lib/passes-summary";
import { apiFetch } from "./client";

// ── Mountain passes endpoints (US-40 seasonal closures & pass status) ──

export interface CheckRoutePassesResponse {
  passes: MountainPass[];
  closed_count: number;
  unknown_count: number;
}

export const passesApi = {
  checkRoute: (
    data: {
      route: Array<{ lat: number; lng: number }>;
      buffer_m?: number;
      for_month?: number;
    },
    init?: RequestInit,
  ) =>
    apiFetch<CheckRoutePassesResponse>("/passes/check-route", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
};
