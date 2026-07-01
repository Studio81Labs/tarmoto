import { $api } from "./apiClient.js";

export function useAdminAdminsList() {
  return $api.useQuery("get", "/admin/admins");
}

export function useCreateAdmin() {
  return $api.useMutation("post", "/admin/admins");
}

export function usePatchAdmin() {
  return $api.useMutation("patch", "/admin/admins/{id}");
}
