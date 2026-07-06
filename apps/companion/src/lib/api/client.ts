import { getSession } from "next-auth/react";
import { createTarmotoClient } from "@tarmoto/openapi-client";
import { createTarmotoQueryClient } from "@tarmoto/openapi-client/react-query";
import type { paths } from "@tarmoto/openapi-client";
import { useAuthStore } from "@/stores/auth";
import { API_HOST, API_BASE } from "@/lib/config";

// Typed openapi-fetch client for all spec-defined endpoints.
//
// `onUnauthorizedRetry` is the defense-in-depth pair to the
// SessionProvider `refetchInterval`: the poll keeps the access
// token fresh under normal continuous use, but a backgrounded
// tab can still wake up with a stale token and click Save before
// the focus-triggered session refresh lands. When that happens,
// `getSession()` forces the NextAuth `jwt` callback to rotate the
// token and we replay the request once with the new bearer —
// fully transparent to the caller. Only if THAT also 401s do we
// clear the session and bounce to /login.
export const api = createTarmotoClient({
  baseUrl: API_HOST,
  getToken: () => useAuthStore.getState().accessToken,
  onUnauthorized: () => useAuthStore.getState().clearSession(),
  onUnauthorizedRetry: async () => {
    const session = await getSession();
    if (!session?.accessToken) return null;
    // RefreshTokenError means the refresh round-trip failed — no
    // point replaying, just let the session clear normally.
    if (session.error === "RefreshTokenError") return null;
    // Hydrate the Zustand store inline so the raw-fetch helpers in
    // this file (`apiFetch`, FormData uploads, trip-share/collab
    // helpers) see the fresh token immediately — `AuthSync`'s
    // useEffect lands a tick later, and any caller firing in that
    // gap would otherwise read the stale token, hit 401, and clear
    // the session before the replayed typed-client call has had a
    // chance to succeed.
    if (session.user) {
      useAuthStore.getState().setSession(
        {
          id: session.user.id,
          email: session.user.email!,
          displayName: session.user.displayName,
          ...(session.user.phone !== undefined
            ? { phone: session.user.phone }
            : {}),
        },
        session.accessToken,
      );
    }
    return session.accessToken;
  },
});

// React Query bindings on top of the same client. Hooks consume
// this as `$api.useQuery("get", "/api/v1/trips")` etc., inferring
// params + response shape from the generated `paths`.
export const $api = createTarmotoQueryClient(api);

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// ── Transitional raw fetch helper ──
// Owner: companion web. Follow-up: #861 endpoint-family split for remaining
// raw helpers (auth bootstrap, trip folders/shares/collab, collections/map
// shares, hazards/closures/POI, community, passes, roads, users, notifications,
// and privacy) after the core trips/exploration/account contracts below.
// Checks res.ok and clears session on 401 (matching openapi-fetch client behavior).
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T }> {
  const token = useAuthStore.getState().accessToken;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers ?? {})),
  };
  const { headers: _, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers });
  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().clearSession();
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      (body as { message?: string }).message ??
        `Request failed (${res.status})`,
      res.status,
      body,
    );
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { data: undefined as T };
  }
  const data = (await res.json()) as T;
  return { data };
}

export type JsonResponse<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends number,
> = paths[Path][Method] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends { content: { "application/json": infer Body } }
      ? Body
      : void
    : never
  : never;

export type JsonRequest<
  Path extends keyof paths,
  Method extends keyof paths[Path],
> = paths[Path][Method] extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

type OpenApiClientResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

export async function openApiData<T>(
  resultPromise: Promise<OpenApiClientResult<T>>,
): Promise<{ data: T }> {
  const result = await resultPromise;
  // Throw on ANY non-2xx, not only when `error` is populated. openapi-fetch
  // leaves `error` unset for an empty-body error response (e.g. a proxy/backend
  // 5xx with `Content-Length: 0`), which would otherwise resolve here as a
  // phantom success — letting callers mutate local cache (delete a collection,
  // etc.) as if a write that never landed had succeeded. Matches the old
  // `apiFetch` path, which checked `res.ok`.
  if (result.error || (result.response && !result.response.ok)) {
    const status = result.response?.status ?? 0;
    throw new ApiError(
      apiErrorMessage(result.error, status),
      status,
      result.error,
    );
  }
  return { data: result.data as T };
}

function apiErrorMessage(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return `Request failed (${status})`;
}
