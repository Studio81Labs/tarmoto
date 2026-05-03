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
import type { Schemas } from "@/types";
import { API_BASE_URL } from "@/config";

type AuthResponse = Schemas["AuthResponseDto"];

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
 * Distinguishable timeout failure. Surfaces from any fetch wrapped
 * by `withTimeout` when the timer fires — the network-error
 * classifier matches on `name === "TimeoutError"` to route only
 * timeout-driven aborts to the offline queues' "queue for later"
 * path. A generic `AbortError` from caller-driven cancellation
 * (e.g. rider taps × to cancel a photo upload) keeps its native
 * shape and bubbles up to the caller, so the cancel takes effect
 * instead of being silently re-queued for retry.
 */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

interface TimeoutHandle {
  signal: AbortSignal;
  dispose: () => void;
  didTimeOut: () => boolean;
}

/**
 * Wrap a fetch with a 15 s deadline, optionally combined with a
 * caller-supplied cancellation signal (e.g. `uploadReviewPhotos`'s
 * abort handle). Returns a fresh signal that aborts on whichever
 * fires first, a `dispose` that clears the timer so a fast response
 * doesn't leak a no-op timer per request, and `didTimeOut()` so
 * call sites can distinguish a timer-driven abort from a caller-
 * driven one and surface the right error class to upstream queues.
 *
 * The DOM `AbortSignal.reason` accessor isn't in `lib: ["es2022"]`,
 * so we use plain `abort()` and track the timeout fact in a
 * closed-over flag rather than the abort reason.
 */
function withTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutHandle {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
    didTimeOut: () => timedOut,
  };
}

/**
 * Substitute a `TimeoutError` for a generic `AbortError` when our
 * timer is the abort source. Call sites that wrap their own fetch
 * (refresh, the 401 retry, `rawFetch`) feed every catch through
 * here so the network-error classifier sees a stable name. The
 * unchanged error rethrows for everything else (caller-driven
 * cancellation, fetch transport failure, …).
 */
function asTimeoutErrorIfFired(
  err: unknown,
  handle: TimeoutHandle,
  timeoutMs: number,
): unknown {
  if (
    handle.didTimeOut() &&
    err instanceof Error &&
    err.name === "AbortError"
  ) {
    return new TimeoutError(timeoutMs);
  }
  return err;
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
    const handle = withTimeout(undefined, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: handle.signal,
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const auth = (await res.json()) as AuthResponse;
      storeTokens(auth);
      return true;
    } catch {
      // Refresh timed out OR network failure — either way the user's
      // session can't be salvaged here; clear tokens so subsequent
      // requests fail fast instead of looping.
      clearTokens();
      return false;
    } finally {
      handle.dispose();
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
 * Per-request timeout handles. Populated in `onRequest` and read by
 * `onResponse` / `onError` so a fast response doesn't leak a no-op
 * timer for the rest of its window (over a long ride session that
 * stacks thousands of dangling timers), and so `onError` can spot a
 * timer-driven abort and substitute a `TimeoutError` for the
 * generic `AbortError` that fetch surfaces.
 */
const requestTimeouts = new Map<string, TimeoutHandle>();

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
    const handle = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
    requestTimeouts.set(id, handle);
    return new Request(request, { signal: handle.signal });
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
      requestTimeouts.get(id)?.dispose();
      requestTimeouts.delete(id);

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
      const retryHandle = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
      try {
        const init: RequestInit = {
          method: request.method,
          headers,
          signal: retryHandle.signal,
        };
        const stashedBody = requestBodies.get(id);
        if (stashedBody !== undefined) init.body = stashedBody;
        return await fetch(request.url, init);
      } catch (err) {
        // Surface a `TimeoutError` instead of the generic
        // `AbortError` so the offline queue's `isNetworkDownError`
        // classifier routes timer-driven aborts to "queue for later"
        // without misclassifying caller-driven cancellation.
        throw asTimeoutErrorIfFired(err, retryHandle, REQUEST_TIMEOUT_MS);
      } finally {
        retryHandle.dispose();
      }
    } finally {
      requestBodies.delete(id);
      // Original timer was already disposed on the 401-retry path;
      // this covers the non-401 / skip-refresh / refresh-failed
      // paths where we returned early without touching the handle.
      requestTimeouts.get(id)?.dispose();
      requestTimeouts.delete(id);
    }
  },
  onError({ id, error }) {
    const handle = requestTimeouts.get(id);
    requestBodies.delete(id);
    requestTimeouts.delete(id);
    handle?.dispose();
    // openapi-fetch lets `onError` substitute the rejection by
    // returning an `Error`. If our timer fired, surface the
    // distinguishable `TimeoutError`; otherwise let the original
    // error propagate (caller-driven cancellation, fetch transport
    // failures, etc.).
    if (handle) {
      const substituted = asTimeoutErrorIfFired(
        error,
        handle,
        REQUEST_TIMEOUT_MS,
      );
      if (substituted !== error && substituted instanceof Error) {
        return substituted;
      }
    }
    return;
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
  const handle = withTimeout(callerSignal ?? undefined, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: merged,
      signal: handle.signal,
    });
  } catch (err) {
    throw asTimeoutErrorIfFired(err, handle, REQUEST_TIMEOUT_MS);
  } finally {
    handle.dispose();
  }
}
