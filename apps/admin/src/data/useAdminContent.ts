import { $api } from "./apiClient.js";

export type ContentTypeParam = "hazard" | "review" | "trip_message";
export type ContentStatusParam = "visible" | "hidden" | "all";

export function useAdminContentList(params: {
  type: ContentTypeParam;
  status?: ContentStatusParam;
  q?: string;
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/admin/content", {
    params: { query: params },
  });
}

export function useHideContent() {
  return $api.useMutation("post", "/admin/content/{type}/{id}/hide");
}

export function useRestoreContent() {
  return $api.useMutation("post", "/admin/content/{type}/{id}/restore");
}

export function useDeleteContent() {
  return $api.useMutation("delete", "/admin/content/{type}/{id}");
}
