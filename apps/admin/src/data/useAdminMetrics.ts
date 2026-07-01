import { $api } from "./apiClient.js";

export function useAdminMetrics() {
  return $api.useQuery("get", "/admin/metrics");
}
