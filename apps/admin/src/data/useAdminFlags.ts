import { $api } from "./apiClient.js";

export function useAdminFeatureFlags() {
  return $api.useQuery("get", "/admin/feature-flags");
}

export function useSetFeatureGlobal() {
  return $api.useMutation("put", "/admin/feature-flags/{feature}/global");
}

export function useClearFeatureGlobal() {
  return $api.useMutation("delete", "/admin/feature-flags/{feature}/global");
}

export function useAdminFeatureFlagUsers(
  feature: string | null,
  params: {
    q?: string;
    override?: "force_on" | "force_off";
    page?: number;
    pageSize?: number;
  },
  enabled: boolean,
) {
  return $api.useQuery(
    "get",
    "/admin/feature-flags/{feature}/users",
    { params: { path: { feature: feature ?? "" }, query: params } },
    { enabled },
  );
}

export function useAdminUserFeatureFlags(userId: string | null) {
  return $api.useQuery(
    "get",
    "/admin/users/{userId}/feature-flags",
    { params: { path: { userId: userId ?? "" } } },
    { enabled: !!userId },
  );
}

export function useSetFeatureOverride() {
  return $api.useMutation(
    "put",
    "/admin/users/{userId}/feature-flags/{feature}",
  );
}

export function useRemoveFeatureOverride() {
  return $api.useMutation(
    "delete",
    "/admin/users/{userId}/feature-flags/{feature}",
  );
}
