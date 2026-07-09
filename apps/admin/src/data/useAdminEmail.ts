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

export function useSendTestDigest() {
  return $api.useMutation("post", "/admin/email/digest-test");
}

export function useResendDigest() {
  return $api.useMutation("post", "/admin/email/digest-resend");
}
