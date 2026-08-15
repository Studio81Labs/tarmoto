import type { components } from "@tarmoto/openapi-client";
import type { PartialNotificationPreferences } from "@/lib/notification-preferences";
import type { PartialPrivacySettings } from "@/lib/privacy-settings";
import type { PrivacySettings } from "@/lib/types";
import { api, openApiData } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

type NotificationPreferences =
  components["schemas"]["NotificationPreferencesResponseDto"];
type UpdateNotificationPreferences =
  components["schemas"]["UpdateNotificationPreferencesDto"];
type InAppNotification = components["schemas"]["InAppNotificationDto"];
type InAppNotificationListResponse =
  components["schemas"]["InAppNotificationListResponseDto"];
type PrivacyPreferences =
  components["schemas"]["PrivacyPreferencesResponseDto"];
type UpdatePrivacyPreferences =
  components["schemas"]["UpdatePrivacyPreferencesDto"];

// ── Account endpoints (generated OpenAPI contract where available) ──
export type SubscriptionSnapshotResponse = JsonResponse<
  "/api/v1/account/subscription",
  "get",
  200
>;
export type CreateCheckoutSessionInput = JsonRequest<
  "/api/v1/account/subscription/checkout",
  "post"
>;
export type CreatePortalSessionInput = JsonRequest<
  "/api/v1/account/subscription/portal",
  "post"
>;
export type RedirectUrlResponse = JsonResponse<
  "/api/v1/account/subscription/checkout",
  "post",
  201
>;
export type VerifyCheckoutSessionInput = JsonRequest<
  "/api/v1/account/subscription/checkout/verify",
  "post"
>;
export type VerifyCheckoutSessionResponse = JsonResponse<
  "/api/v1/account/subscription/checkout/verify",
  "post",
  201
>;
export type BikeResponse = JsonResponse<
  "/api/v1/account/bikes",
  "get",
  200
>[number];
export type CreateBikeInput = JsonRequest<"/api/v1/account/bikes", "post">;
export type UpdateBikeInput = JsonRequest<
  "/api/v1/account/bikes/{id}",
  "patch"
>;
export type DataExportRequestView = JsonResponse<
  "/api/v1/account/data-export",
  "post",
  202
>;
export type DeleteAccountInput = JsonRequest<"/api/v1/account", "delete">;
export type DeleteAccountResponse = JsonResponse<
  "/api/v1/account",
  "delete",
  200
>;

export const accountApi = {
  // Profile updates use `usersApi.updateMe` (PATCH /users/me) — the
  // canonical path agreed across mobile + web. The previous
  // `accountApi.updateProfile` shim hit `/account/profile` which the
  // backend never exposed; it was a dead caller and has been removed.
  getSubscription: () =>
    openApiData<SubscriptionSnapshotResponse>(
      api.GET("/api/v1/account/subscription"),
    ),
  createCheckoutSession: (data: CreateCheckoutSessionInput) =>
    openApiData<RedirectUrlResponse>(
      api.POST("/api/v1/account/subscription/checkout", { body: data }),
    ),
  /**
   * Confirms the Checkout the rider just returned from. The session id comes
   * from the address bar, so the BACKEND decides what it means — it reads the
   * session back from Stripe and rejects one belonging to another rider.
   */
  verifyCheckoutSession: (data: VerifyCheckoutSessionInput) =>
    openApiData<VerifyCheckoutSessionResponse>(
      api.POST("/api/v1/account/subscription/checkout/verify", { body: data }),
    ),
  createPortalSession: (
    data: Partial<CreatePortalSessionInput> = { flow: "manage" },
  ) =>
    openApiData<RedirectUrlResponse>(
      api.POST("/api/v1/account/subscription/portal", {
        body: data as CreatePortalSessionInput,
      }),
    ),
  getBikes: () => openApiData<BikeResponse[]>(api.GET("/api/v1/account/bikes")),
  addBike: (data: CreateBikeInput) =>
    openApiData<BikeResponse>(
      api.POST("/api/v1/account/bikes", { body: data }),
    ),
  updateBike: (id: string, data: UpdateBikeInput) =>
    openApiData<BikeResponse>(
      api.PATCH("/api/v1/account/bikes/{id}", {
        params: { path: { id } },
        body: data,
      }),
    ),
  deleteBike: (id: string) =>
    openApiData<void>(
      api.DELETE("/api/v1/account/bikes/{id}", {
        params: { path: { id } },
      }),
    ),
  requestDataExport: () =>
    openApiData<DataExportRequestView>(api.POST("/api/v1/account/data-export")),
  getDataExport: (id: string) =>
    openApiData<DataExportRequestView>(
      api.GET("/api/v1/account/data-export/{id}", {
        params: { path: { id } },
      }),
    ),
  deleteAccount: (input: DeleteAccountInput) =>
    openApiData<DeleteAccountResponse>(
      api.DELETE("/api/v1/account", { body: input }),
    ),
  // Notifications + notification preferences. The settings page still maps
  // through the `@tarmoto/shared`-based merge helpers (defaults + category
  // enums the generated schema doesn't carry); the wire types are generated.
  getNotificationPreferences: () =>
    openApiData<NotificationPreferences>(
      api.GET("/api/v1/me/notification-preferences"),
    ),
  // The settings page builds a `PartialNotificationPreferences` (partial
  // per-channel toggles); the generated update DTO types every supplied
  // category as a full channel set, so cast at the boundary — the backend
  // merges partial channel updates.
  updateNotificationPreferences: (data: PartialNotificationPreferences) =>
    openApiData<NotificationPreferences>(
      api.PUT("/api/v1/me/notification-preferences", {
        body: data as UpdateNotificationPreferences,
      }),
    ),
  getNotifications: () =>
    openApiData<InAppNotificationListResponse>(
      api.GET("/api/v1/me/notifications"),
    ),
  markNotificationRead: (id: string) =>
    openApiData<InAppNotification>(
      api.PATCH("/api/v1/me/notifications/{id}/read", {
        params: { path: { id } },
      }),
    ),
  markAllNotificationsRead: () =>
    openApiData<InAppNotificationListResponse>(
      api.PATCH("/api/v1/me/notifications/read-all"),
    ),
  // #279: typed `/account/privacy` endpoint (GET/PUT). The backend
  // uses snake_case keys; the companion's UI types are camelCase, so
  // we translate at the boundary to keep the page code unchanged.
  getPrivacySettings: async (): Promise<{ data: PrivacySettings }> => {
    const { data } = await openApiData<PrivacyPreferences>(
      api.GET("/api/v1/account/privacy"),
    );
    return { data: privacyFromBackend(data) };
  },
  updatePrivacySettings: async (
    data: PartialPrivacySettings,
  ): Promise<{ data: PrivacySettings }> => {
    const { data: updated } = await openApiData<PrivacyPreferences>(
      api.PUT("/api/v1/account/privacy", { body: privacyToBackend(data) }),
    );
    return { data: privacyFromBackend(updated) };
  },
};

function privacyFromBackend(p: PrivacyPreferences): PrivacySettings {
  return {
    profileVisibility: p.profile_visibility,
    defaultRideSharing: p.default_ride_sharing,
    roadDataContribution: p.road_data_contribution,
    locationRetention: p.location_retention,
    analyticsConsent: p.analytics_consent,
    personalizedRecommendationsConsent: p.personalized_recommendations_consent,
  };
}

function privacyToBackend(p: PartialPrivacySettings): UpdatePrivacyPreferences {
  const out: UpdatePrivacyPreferences = {};
  if (p.profileVisibility !== undefined) {
    out.profile_visibility = p.profileVisibility;
  }
  if (p.defaultRideSharing !== undefined) {
    out.default_ride_sharing = p.defaultRideSharing;
  }
  if (p.roadDataContribution !== undefined) {
    out.road_data_contribution = p.roadDataContribution;
  }
  if (p.locationRetention !== undefined) {
    out.location_retention = p.locationRetention;
  }
  if (p.analyticsConsent !== undefined) {
    out.analytics_consent = p.analyticsConsent;
  }
  if (p.personalizedRecommendationsConsent !== undefined) {
    out.personalized_recommendations_consent =
      p.personalizedRecommendationsConsent;
  }
  return out;
}
