import { $api } from "./apiClient.js";

export function useAdminUsersList(params: {
  q?: string;
  deleted?: "active" | "deleted" | "all";
  subscription?: string;
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/admin/users", {
    params: { query: params },
  });
}

export function useAdminUserDetail(id: string | null) {
  return $api.useQuery(
    "get",
    "/admin/users/{id}",
    { params: { path: { id: id ?? "" } } },
    { enabled: !!id },
  );
}

export function useAdminUserNotificationPrefs(id: string | null) {
  return $api.useQuery(
    "get",
    "/admin/users/{id}/notification-preferences",
    { params: { path: { id: id ?? "" } } },
    { enabled: !!id },
  );
}

export function useUpdateUserNotificationPrefs() {
  return $api.useMutation(
    "patch",
    "/admin/users/{id}/notification-preferences",
  );
}

export function useSoftDeleteUser() {
  return $api.useMutation("delete", "/admin/users/{id}");
}

export function useRestoreUser() {
  return $api.useMutation("post", "/admin/users/{id}/restore");
}
