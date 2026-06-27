import { $api } from "./apiClient.js";

export function useAdminUsersList(params: {
  q?: string;
  deleted?: "active" | "deleted" | "all";
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/api/v1/admin/users", {
    params: { query: params },
  });
}

export function useAdminUserDetail(id: string | null) {
  return $api.useQuery(
    "get",
    "/api/v1/admin/users/{id}",
    { params: { path: { id: id ?? "" } } },
    { enabled: !!id },
  );
}

export function useSoftDeleteUser() {
  return $api.useMutation("delete", "/api/v1/admin/users/{id}");
}

export function useRestoreUser() {
  return $api.useMutation("post", "/api/v1/admin/users/{id}/restore");
}
