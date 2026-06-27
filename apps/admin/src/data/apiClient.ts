import createClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import type { paths } from "@tarmoto/openapi-client";

export const ADMIN_AUTH_EXPIRED_EVENT = "tarmoto-admin-auth-expired";

const REFRESH_RETRY_DELAY_MS = 250;
const MAX_REFRESH_RETRIES = 2;

const NO_REFRESH_PATHS = [
  "/api/v1/admin/auth/login",
  "/api/v1/admin/auth/refresh",
  "/api/v1/admin/auth/logout",
];

let inflightRefresh: Promise<boolean> | null = null;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname + input.search;
  return new URL(input.url).pathname;
}

async function refreshOnce(): Promise<boolean> {
  if (!inflightRefresh) {
    inflightRefresh = fetch("/api/v1/admin/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}

export async function adminFetchWithRefresh(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  const withCreds: RequestInit = { ...init, credentials: "include" };
  const replaySource = input instanceof Request ? input.clone() : input;
  const response = await fetch(input, withCreds);

  if (
    response.status !== 401 ||
    NO_REFRESH_PATHS.some((p) => url.startsWith(p))
  ) {
    return response;
  }

  let refreshed = await refreshOnce();
  for (
    let attempt = 0;
    !refreshed && attempt < MAX_REFRESH_RETRIES;
    attempt++
  ) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, REFRESH_RETRY_DELAY_MS),
    );
    refreshed = await refreshOnce();
  }
  if (!refreshed) {
    window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    return response;
  }
  return fetch(
    replaySource instanceof Request ? replaySource.clone() : replaySource,
    withCreds,
  );
}

export const apiClient = createClient<paths>({
  baseUrl: "",
  fetch: adminFetchWithRefresh,
});

export const $api = createQueryClient(apiClient);
