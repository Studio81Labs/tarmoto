import { $api } from "./apiClient.js";

export function useAdminMetrics() {
  return $api.useQuery("get", "/api/v1/admin/metrics");
}
