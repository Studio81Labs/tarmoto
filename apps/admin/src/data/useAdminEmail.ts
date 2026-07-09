import { $api } from "./apiClient.js";

export function useAdminEmailLog(params: {
  status?: "sent" | "failed";
  tag?: string;
  recipient?: string;
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/admin/email/log", {
    params: { query: params },
  });
}
