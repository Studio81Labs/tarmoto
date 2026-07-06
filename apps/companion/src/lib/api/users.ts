import type { FeatureSnapshot, SubscriptionTier } from "@tarmoto/shared";
import { useAuthStore } from "@/stores/auth";
import { API_BASE } from "@/lib/config";
import { apiFetch, ApiError } from "./client";

// ── Users endpoints (US-59 profile) ──

export interface UserProfileResponse {
  id: string;
  email: string;
  display_name: string;
  phone: string | null;
  avatar_url: string | null;
  bio: string | null;
  home_region: string | null;
  home_location: { lat: number; lng: number } | null;
  work_location: { lat: number; lng: number } | null;
  preferences: Record<string, unknown>;
  /** The rider's subscription tier — drives feature grants server-side. */
  subscription_tier: SubscriptionTier;
  /**
   * Resolved feature entitlements (tier + overrides). UI gating only —
   * gated endpoints re-check server-side and answer 403 when off. Read
   * via `isFeatureEnabled(user.features, key)` from `@tarmoto/shared`
   * so a missing key fails closed.
   */
  features: FeatureSnapshot;
  created_at: string;
}

/** Wire shape of the rider's saved planner defaults (revision 3 §F). */
export type UserRoutePrefsWire = {
  road_preference:
    | "direct"
    | "balanced"
    | "scenic_balance"
    | "maximum_twisty"
    | "efficient_loop";
  avoid_highways: boolean;
  avoid_tolls: boolean;
  avoid_unpaved: boolean;
  surfaces: string[];
  min_quality: "any" | "fair_or_better" | "good_or_better" | "excellent_only";
};

export interface UpdateProfileInput {
  display_name?: string;
  phone?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  home_region?: string | null;
  preferences?: { route_prefs?: UserRoutePrefsWire };
}

export const usersApi = {
  getMe: (init?: RequestInit) =>
    apiFetch<UserProfileResponse>("/users/me", init),
  uploadAvatar: async (file: File) => {
    const token = useAuthStore.getState().accessToken;
    const body = new FormData();
    body.append("file", file);

    const res = await fetch(`${API_BASE}/users/me/avatar`, {
      method: "POST",
      body,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });

    if (!res.ok) {
      if (res.status === 401) useAuthStore.getState().clearSession();
      const payload = await res.json().catch(() => ({}));
      throw new ApiError(
        (payload as { message?: string }).message ??
          `Request failed (${res.status})`,
        res.status,
        payload,
      );
    }

    return { data: (await res.json()) as UserProfileResponse };
  },
  updateMe: (data: UpdateProfileInput) =>
    apiFetch<UserProfileResponse>("/users/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};
