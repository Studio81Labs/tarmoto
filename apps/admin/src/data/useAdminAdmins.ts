import { $api } from "./apiClient.js";

export function useAdminAdminsList() {
  return $api.useQuery("get", "/api/v1/admin/admins");
}

export function useCreateAdmin() {
  return $api.useMutation("post", "/api/v1/admin/admins");
}

export function usePatchAdmin() {
  return $api.useMutation("patch", "/api/v1/admin/admins/{id}");
}
