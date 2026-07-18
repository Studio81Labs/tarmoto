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

export function useAdminFeatureLimits() {
  return $api.useQuery("get", "/admin/feature-limits");
}

export function useSetLimitGlobal() {
  return $api.useMutation("put", "/admin/feature-limits/{feature}/global");
}

export function useClearLimitGlobal() {
  return $api.useMutation("delete", "/admin/feature-limits/{feature}/global");
}

export function useAdminUserFeatureLimits(userId: string | null) {
  return $api.useQuery(
    "get",
    "/admin/users/{userId}/feature-limits",
    { params: { path: { userId: userId ?? "" } } },
    { enabled: !!userId },
  );
}

export function useSetLimitOverride() {
  return $api.useMutation(
    "put",
    "/admin/users/{userId}/feature-limits/{feature}",
  );
}

export function useRemoveLimitOverride() {
  return $api.useMutation(
    "delete",
    "/admin/users/{userId}/feature-limits/{feature}",
  );
}

export function useAdminSystemSwitches() {
  return $api.useQuery("get", "/admin/system-switches");
}

export function useDisableSystemSwitch() {
  return $api.useMutation("put", "/admin/system-switches/{key}/disable");
}

export function useEnableSystemSwitch() {
  return $api.useMutation("delete", "/admin/system-switches/{key}/disable");
}
