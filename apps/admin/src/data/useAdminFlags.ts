import { $api } from "./apiClient.js";

export function useAdminFlagsList() {
  return $api.useQuery("get", "/admin/flags");
}

export function useCreateFlag() {
  return $api.useMutation("post", "/admin/flags");
}

export function useUpdateFlag() {
  return $api.useMutation("patch", "/admin/flags/{id}");
}

export function useDeleteFlag() {
  return $api.useMutation("delete", "/admin/flags/{id}");
}
