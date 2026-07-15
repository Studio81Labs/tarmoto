import { $api } from "./apiClient.js";

export function useEmailTemplates() {
  return $api.useQuery("get", "/admin/email/templates");
}

export function useEmailTemplate(tag: string, locale: string) {
  return $api.useQuery(
    "get",
    "/admin/email/templates/{tag}/{locale}",
    { params: { path: { tag, locale } } },
    { enabled: tag.length > 0 },
  );
}

export function useSaveDraft() {
  return $api.useMutation("put", "/admin/email/templates/{tag}/{locale}/draft");
}

export function usePreview() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/preview",
  );
}

export function useTestSend() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/test-send",
  );
}

export function usePublish() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/publish",
  );
}

export function useReset() {
  return $api.useMutation(
    "delete",
    "/admin/email/templates/{tag}/{locale}/override",
  );
}

export function useTemplateHistory(
  tag: string,
  locale: string,
  enabled: boolean,
) {
  return $api.useQuery(
    "get",
    "/admin/email/templates/{tag}/{locale}/history",
    { params: { path: { tag, locale } } },
    { enabled: enabled && tag.length > 0 },
  );
}

export function useRevertVersion() {
  return $api.useMutation(
    "post",
    "/admin/email/templates/{tag}/{locale}/history/{version}/revert",
  );
}
