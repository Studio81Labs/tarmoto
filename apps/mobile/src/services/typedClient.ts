/**
 * Typed @tarmoto/openapi client singleton for the mobile app.
 *
 * Wraps `createApiClient` with:
 *   - MMKV-backed access/refresh token storage
 *   - A 401 middleware that refreshes the access token once and retries
 *     the original request transparently. Refresh + auth endpoints are
 *     skipped to avoid recursion. A single in-flight refresh is shared
 *     across concurrent 401s so a burst of tunnel-time requests doesn't
 *     spend N refresh tokens.
 *
 * Everything in `services/api.ts` consumes the singleton exported here.
 * Helpers that need to bypass the refresh path (logout's device-token
 * DELETE) get raw fetch via `rawFetch` so a stale bearer can't trigger
 * the retry loop documented in `pushRegistration.unregisterPush`.
 */

import { createMMKV } from "react-native-mmkv";
import { createApiClient } from "@tarmoto/openapi/client";
import type { components } from "@tarmoto/openapi";
import { API_BASE_URL } from "@/config";

type AuthResponse = components["schemas"]["AuthResponseDto"];

const storage = createMMKV({ id: "tarmoto-auth" });

const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";

/**
 * Per-request timeout. Matches the previous axios default (`timeout:
 * 15000`). Without this, a stalled-but-not-disconnected backend would
 * hang on iOS for ~60 s (the platform-default fetch timeout) before
 * the offline queues' "queue for later" path could take over.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Path that must NEVER be refresh-retried — refreshing on a 401 from
 *  the refresh endpoint itself would cause infinite recursion. */
const REFRESH_PATH = "/api/v1/auth/refresh";
/** Auth endpoints intentionally return 401 on bad credentials; retrying
 *  via refresh would mask the credential error and burn a refresh token. */
const SKIP_REFRESH_PATHS: readonly string[] = [
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  REFRESH_PATH,
];

/**
 * Wrap a fetch with a timeout, optionally combined with a
 * caller-supplied cancellation signal (e.g. `uploadReviewPhotos`'s
 * abort handle). Returns a fresh signal that aborts on whichever
 * fires first, plus a `dispose` that clears the timer so a fast
 * response doesn't leak a 15 s no-op timer per request — over a
 * long ride session that would stack thousands of dangling timers
 * in the runtime.
 *
 * The DOM `AbortSignal.reason` accessor isn't in `lib: ["es2022"]`,
 * so we use plain `abort()` and rely on the network-error classifier
 * to recognise the resulting `AbortError` (no `.status`, message
 * matches the offline regex) as a "queue for later" failure.
 */
function withTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

let inflightRefresh: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return storage.getString(ACCESS_TOKEN_KEY) ?? null;
}

function getRefreshToken(): string | null {
  return storage.getString(REFRESH_TOKEN_KEY) ?? null;
}

export function storeTokens(auth: AuthResponse): void {
  storage.set(ACCESS_TOKEN_KEY, auth.access_token);
  storage.set(REFRESH_TOKEN_KEY, auth.refresh_token);
}

export function clearTokens(): void {
  storage.remove(ACCESS_TOKEN_KEY);
  storage.remove(REFRESH_TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

/**
 * Imperative refresh — POSTs the stored refresh token to /auth/refresh
 * via raw fetch (bypassing the typed-client middleware so the call
 * itself can't loop). Persists new tokens on success, clears them on
 * failure. Concurrent calls share a single inflight promise.
 */
async function refreshAccessToken(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  inflightRefresh = (async () => {
    const { signal, dispose } = withTimeout(undefined, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal,
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const auth = (await res.json()) as AuthResponse;
      storeTokens(auth);
      return true;
    } catch {
      clearTokens();
      return false;
    } finally {
      dispose();
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

const baseClient = createApiClient({
  baseUrl: API_BASE_URL,
  getToken: getAccessToken,
});

/**
 * Per-request stash of the original POST/PATCH/PUT body bytes,
 * captured in `onRequest` before fetch consumes the body stream and
 * read back in the 401-retry path. Cloning the Request inside
 * `onResponse` is too late — by then `request.bodyUsed` is true and
 * `clone()` throws TypeError per WHATWG, which would leave token
 * refresh broken for any payload-bearing request (sensor uploads,
 * hazard reports, profile updates, …). Keyed by the middleware's
 * unique request id; cleared on response or error so a long-lived
 * client can't accumulate bytes.
 */
const requestBodies = new Map<string, ArrayBuffer>();

/**
 * Per-request `dispose` callbacks that clear the 15 s timeout timer.
 * Populated in `onRequest` and called from `onResponse` / `onError`
 * so a fast response doesn't leak a no-op timer for the rest of its
 * window — over a long ride session that would otherwise stack
 * thousands of dangling timers in the runtime.
 */
const requestDisposers = new Map<string, () => void>();

baseClient.use({
  async onRequest({ request, id }) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      // Clone first — `arrayBuffer()` on the clone consumes the
      // clone's body stream while leaving the original request body
      // intact for the imminent fetch. The original then ships its
      // body normally.
      const buf = await request.clone().arrayBuffer();
      if (buf.byteLength > 0) requestBodies.set(id, buf);
    }
    // Apply the 15 s deadline by replacing the request with one that
    // carries our combined signal. A caller-supplied signal (e.g.
    // `uploadReviewPhotos` cancellation) is preserved because
    // `withTimeout` propagates its abort.
    const { signal, dispose } = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
    requestDisposers.set(id, dispose);
    return new Request(request, { signal });
  },
  async onResponse({ response, request, schemaPath, id }) {
    try {
      if (response.status !== 401) return response;
      if (SKIP_REFRESH_PATHS.includes(schemaPath)) return response;

      const refreshed = await refreshAccessToken();
      if (!refreshed) return response;

      // Dispose the ORIGINAL request's timer NOW, before chaining
      // the retry to its signal. The 401-detection plus refresh
      // round-trip may have already eaten 10+ s of the original
      // 15 s window; if we leave the original timer armed, it
      // fires mid-retry and aborts the fresh fetch through the
      // chained signal seconds after it starts. Calling
      // `dispose()` only clears the timer — the caller-signal
      // listener installed by `withTimeout` stays connected, so
      // caller cancellation still propagates into the retry.
      requestDisposers.get(id)?.();
      requestDisposers.delete(id);

      // Build a fresh Request with the new bearer rather than mutating
      // headers on a clone. WHATWG `Request.clone().headers` is
      // immutable, and on RN's whatwg-fetch polyfill `set()` is a
      // silent no-op there — the retried request would otherwise go
      // out with the same expired bearer and 401 again.
      const newToken = getAccessToken();
      const headers = new Headers();
      request.headers.forEach((value, key) => headers.set(key, value));
      if (newToken) headers.set("Authorization", `Bearer ${newToken}`);

      // Fresh 15 s deadline for the retry chained to the caller's
      // signal (via the original combined signal whose timer we
      // just disposed). Caller cancellation propagates; the
      // disposed original timer cannot.
      const retryTimeout = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
      try {
        const init: RequestInit = {
          method: request.method,
          headers,
          signal: retryTimeout.signal,
        };
        const stashedBody = requestBodies.get(id);
        if (stashedBody !== undefined) init.body = stashedBody;
        return await fetch(request.url, init);
      } finally {
        retryTimeout.dispose();
      }
    } finally {
      requestBodies.delete(id);
      // Original timer was already disposed on the 401-retry path;
      // these calls cover the non-401 / skip-refresh / refresh-failed
      // paths where we returned early without touching the disposer.
      requestDisposers.get(id)?.();
      requestDisposers.delete(id);
    }
  },
  onError({ id }) {
    // Network failures skip onResponse, so clean up here too — leaving
    // bytes / timers in the maps would leak memory and dangling
    // setTimeout handles across long-lived sessions.
    requestBodies.delete(id);
    requestDisposers.get(id)?.();
    requestDisposers.delete(id);
  },
});

export const client = baseClient;

/**
 * Raw fetch escape hatch for endpoints that must bypass the typed
 * client and its refresh middleware. The only intentional caller is
 * `pushRegistration.unregisterPush` — see its comment for the
 * logout-loop rationale. Returns the Response so callers can check
 * `res.ok` themselves.
 */
export async function rawFetch(
  path: string,
  init: RequestInit & { bearer?: string },
): Promise<Response> {
  const { bearer, headers, signal: callerSignal, ...rest } = init;
  const merged = new Headers(headers);
  if (bearer) merged.set("Authorization", `Bearer ${bearer}`);
  const { signal, dispose } = withTimeout(
    callerSignal ?? undefined,
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: merged,
      signal,
    });
  } finally {
    dispose();
  }
}
