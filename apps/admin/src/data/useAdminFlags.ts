import { $api } from "./apiClient.js";

export function useAdminFlagsList() {
  return $api.useQuery("get", "/api/v1/admin/flags");
}

export function useCreateFlag() {
  return $api.useMutation("post", "/api/v1/admin/flags");
}

export function useUpdateFlag() {
  return $api.useMutation("patch", "/api/v1/admin/flags/{id}");
}

export function useDeleteFlag() {
  return $api.useMutation("delete", "/api/v1/admin/flags/{id}");
}
