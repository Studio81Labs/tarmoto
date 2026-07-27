import { getSession } from "next-auth/react";
import { createTarmotoClient } from "@tarmoto/openapi-client";
import { createTarmotoQueryClient } from "@tarmoto/openapi-client/react-query";
import type { paths } from "@tarmoto/openapi-client";
import { useAuthStore } from "@/stores/auth";
import { API_HOST } from "@/lib/config";
import { getDocumentLocale, t } from "@/i18n";

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

/**
 * Browser requests must carry the language already committed to the document.
 * The browser's implicit Accept-Language reflects OS preferences, which can
 * differ from an explicit account/cookie selection. Registration consumes
 * this header to seed User.language, so leaving it implicit creates an
 * immediately stale account on the first non-English rollout.
 */
export function withDocumentLanguage(request: Request): Request {
  if (request.headers.has("Accept-Language")) return request;
  const headers = new Headers(request.headers);
  headers.set("Accept-Language", getDocumentLocale());
  return new Request(request, { headers });
}

api.use({
  onRequest({ request }) {
    return withDocumentLanguage(request);
  },
});

// React Query bindings on top of the same client. Hooks consume
// this as `$api.useQuery("get", "/api/v1/trips")` etc., inferring
// params + response shape from the generated `paths`.
export const $api = createTarmotoQueryClient(api);

export class ApiError extends Error {
  readonly localizedUserMessage?: true;
  readonly status: number;
  readonly body: unknown;

  constructor(
    message: string,
    status: number,
    body: unknown,
    localizedUserMessage = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    if (localizedUserMessage) this.localizedUserMessage = true;
  }
}

/**
 * Extract just the abort `signal` from a caller's `RequestInit`. Spreading a
 * whole `RequestInit` into the openapi-fetch per-request options clashes with
 * the client's typed `body`/`headers`, so read helpers that accept an `init`
 * for cancellation forward only the signal.
 */
export function reqSignal(init?: { signal?: AbortSignal | null }): {
  signal?: AbortSignal;
} {
  return init?.signal != null ? { signal: init.signal } : {};
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
      true,
    );
  }
  return { data: result.data as T };
}

function apiErrorMessage(body: unknown, status: number): string {
  void body;
  const locale = getDocumentLocale();
  if (status === 401)
    return t("Your session has expired. Sign in again.", undefined, locale);
  if (status === 403)
    return t("You don't have permission to do that.", undefined, locale);
  if (status === 404)
    return t("The requested item could not be found.", undefined, locale);
  if (status === 409) {
    return t(
      "That change conflicts with the current state. Refresh and try again.",
      undefined,
      locale,
    );
  }
  if (status === 400 || status === 422) {
    return t(
      "Some information is invalid. Check it and try again.",
      undefined,
      locale,
    );
  }
  if (status >= 500) {
    return t(
      "The server is temporarily unavailable. Try again shortly.",
      undefined,
      locale,
    );
  }
  return t("Check your connection and try again.", undefined, locale);
}
