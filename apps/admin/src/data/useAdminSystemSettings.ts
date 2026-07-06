import { $api } from "./apiClient.js";

export function useLaunchTier() {
  return $api.useQuery("get", "/admin/system-settings/launch-tier");
}

export function useSetLaunchTier() {
  return $api.useMutation("put", "/admin/system-settings/launch-tier");
}
