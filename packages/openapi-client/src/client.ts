import createFetchClient, {
  type Client,
  type ClientOptions,
} from "openapi-fetch";

import type { BrowserSafePaths } from "./browser-safe";

/**
 * Raw openapi-fetch client, strongly typed against the
 * `BrowserSafePaths` view of the generated paths — internal-only
 * headers like `X-Internal-Token` are stripped at the type level,
 * so a browser consumer can't accidentally call internal routes
 * with a token it shouldn't have. See `./browser-safe`.
 *
 * Mobile pulls this via the default package entry; the React
 * Query helper lives in `./react-query` so RN apps that don't
 * use TanStack Query don't pay for `openapi-react-query` /
 * `@tanstack/react-query` as a transitive dep.
 */
export type TarmotoClient = Client<BrowserSafePaths>;

export interface CreateTarmotoClientOptions extends ClientOptions {
  /**
   * Returns the current bearer token (or null when unauthenticated).
   * Read on every request so a token refresh after the client was
   * built still flows through.
   */
  getToken?: () => string | null;
  /**
   * Called whenever a response returns 401 AND the
   * `onUnauthorizedRetry` hook (if provided) couldn't recover. The
   * companion uses this to clear the Zustand auth-store session
   * and bounce the user to /login.
   */
  onUnauthorized?: () => void;
  /**
   * Optional defense-in-depth: when a 401 arrives, this hook is
   * given a chance to refresh the session and return a new bearer.
   * If it returns a non-null token, the original request is replayed
   * once with that token; if the replay also 401s (or the hook
   * returns null), `onUnauthorized` fires. Concurrent 401s share a
   * single refresh promise so we don't fan out N session-refresh
   * calls and burn the refresh token via parallel rotation. Pass
   * `null`/omit to keep the old "clear immediately" behavior used by
   * mobile (which doesn't ride NextAuth's session machinery).
   */
  onUnauthorizedRetry?: () => Promise<string | null>;
}

export function createTarmotoClient(
  options: CreateTarmotoClientOptions = {},
): TarmotoClient {
  const { getToken, onUnauthorized, onUnauthorizedRetry, ...rest } = options;
  const client = createFetchClient<BrowserSafePaths>(rest);

  // Cache request bodies as raw bytes keyed by the Request object so
  // a 401 retry can rebuild the request with the exact same payload.
  // POST/PATCH/PUT bodies are normally one-shot ReadableStreams that
  // can't be replayed once `fetch` has consumed them; capturing the
  // serialized body in `onRequest` sidesteps that.
  //
  // We store the `ArrayBuffer` (not the decoded text). Binary
  // payloads exist in the generated paths — multipart uploads for
  // hazard photos, avatars, and review photos — and `.text()` would
  // UTF-8-decode their bytes and corrupt the replay; `.arrayBuffer()`
  // preserves the raw bytes for any content type, JSON and binary
  // alike.
  const capturedBodies = new WeakMap<Request, ArrayBuffer | null>();

  // Single in-flight refresh promise — if three queries 401 in the
  // same tick we want one `getSession()` round-trip, not three (the
  // backend rotates refresh tokens on use, so a parallel rotation
  // would invalidate two of the three).
  let pendingRefresh: Promise<string | null> | null = null;
  const startRefresh = (): Promise<string | null> => {
    if (!onUnauthorizedRetry) return Promise.resolve(null);
    if (pendingRefresh) return pendingRefresh;
    const inflight = (async () => {
      try {
        return await onUnauthorizedRetry();
      } catch {
        return null;
      }
    })();
    pendingRefresh = inflight;
    // Clear after the promise settles so a *new* 401 after the
    // refresh resolves can start a fresh refresh attempt.
    void inflight.finally(() => {
      if (pendingRefresh === inflight) pendingRefresh = null;
    });
    return inflight;
  };

  if (getToken || onUnauthorizedRetry) {
    client.use({
      async onRequest({ request }) {
        if (getToken) {
          const token = getToken();
          if (token) {
            request.headers.set("Authorization", `Bearer ${token}`);
          }
        }
        // Cache the body so we can replay on 401. Avoid touching
        // empty bodies — `request.clone()` is cheap but draining a
        // missing stream isn't useful and we'd then carry an empty
        // buffer into the retry and trip strict content-length
        // handlers.
        if (onUnauthorizedRetry && request.body) {
          try {
            capturedBodies.set(request, await request.clone().arrayBuffer());
          } catch {
            capturedBodies.set(request, null);
          }
        }
        return request;
      },
    });
  }

  if (onUnauthorized || onUnauthorizedRetry) {
    client.use({
      async onResponse({ request, response }) {
        if (response.status !== 401) return response;

        // Without a retry hook there's nothing to try — fall back
        // to the old "clear session" behavior.
        if (!onUnauthorizedRetry) {
          onUnauthorized?.();
          return response;
        }

        const newToken = await startRefresh();
        if (!newToken) {
          onUnauthorized?.();
          return response;
        }

        // Replay the original request once with the fresh token.
        // Going through bare `fetch` (not the openapi-fetch client)
        // intentionally bypasses these middlewares so we can't
        // loop: a second 401 here is terminal.
        const retryHeaders = new Headers(request.headers);
        retryHeaders.set("Authorization", `Bearer ${newToken}`);
        const replayBody = capturedBodies.get(request) ?? null;
        const replay = await fetch(request.url, {
          method: request.method,
          headers: retryHeaders,
          body: replayBody,
          signal: request.signal,
          credentials: request.credentials,
          mode: request.mode,
          redirect: request.redirect,
          referrer: request.referrer,
        });

        if (replay.status === 401) {
          onUnauthorized?.();
        }
        return replay;
      },
    });
  }

  return client;
}
