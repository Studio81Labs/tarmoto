/**
 * Typed @tarmoto/openapi-client singleton for the mobile app.
 *
 * Wraps `createTarmotoClient` with:
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
import { createTarmotoClient } from "@tarmoto/openapi-client";
import type { Schemas } from "@/types";
import { API_BASE_URL } from "@/config";
import { clearCachedPreferences } from "./privacyCache";
import { detectDeviceLocale } from "@/i18n/deviceLocale";
import { getRequestLanguage } from "@/i18n";

type AuthResponse = Schemas["AuthResponseDto"];
type CachedUser = Schemas["UserResponseDto"];

interface AuthStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

let storage: AuthStorage = createMMKV({ id: "tarmoto-auth" });

const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";
// #279 / #501 — stable identifier for the authenticated rider,
// rotated only on login / register / logout (NOT on access-token
// refresh). Privacy-cache writes use this to detect "logged out"
// or "different user signed in" mid-flight while still allowing
// the normal access-token rotation by the 401 refresh middleware.
const USER_ID_KEY = "user_id";
const CACHED_USER_KEY = "cached_user";

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

let inflightRefresh: Promise<string | null> | null = null;

// Session incarnation counter. Bumped on login/register (`storeTokens` called
// with `{ newSession: true }`) and logout / 401-invalidation (`clearTokens`),
// but NOT on access-token rotation — the backend returns the same `user` shape
// on refresh, so rotation is told apart by the CALLER, not the body. Stable
// across rotation yet changes across a logout→login even to the SAME account.
// Folded into the auth-session snapshot so a `/users/me` publisher that spanned
// a re-login is rejected — its captured epoch no longer matches — instead of
// clobbering the fresher login snapshot with a stale one.
let sessionEpoch = 0;

/** Current session incarnation — see `sessionEpoch`. */
export function getSessionEpoch(): number {
  return sessionEpoch;
}

interface StoredAuthSession {
  accessToken: string | null;
  refreshToken: string;
  userId: string | null;
}

function isStoredSessionCurrent(session: StoredAuthSession): boolean {
  return (
    getAccessToken() === session.accessToken &&
    getRefreshToken() === session.refreshToken &&
    getAuthenticatedUserId() === session.userId
  );
}

export function getAccessToken(): string | null {
  return storage.getString(ACCESS_TOKEN_KEY) ?? null;
}

/** Last authenticated profile for an offline-safe cold start. */
export function getCachedUser(): CachedUser | null {
  const raw = storage.getString(CACHED_USER_KEY);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as Partial<CachedUser>;
    const authenticatedUserId = storage.getString(USER_ID_KEY);
    if (
      typeof user.id !== "string" ||
      !user.id ||
      (authenticatedUserId && authenticatedUserId !== user.id)
    ) {
      storage.remove(CACHED_USER_KEY);
      return null;
    }
    return user as CachedUser;
  } catch {
    storage.remove(CACHED_USER_KEY);
    return null;
  }
}

export function setCachedUser(user: CachedUser): void {
  storage.set(CACHED_USER_KEY, JSON.stringify(user));
  storage.set(USER_ID_KEY, user.id);
}

function getRefreshToken(): string | null {
  return storage.getString(REFRESH_TOKEN_KEY) ?? null;
}

/**
 * Persist an auth token pair. `newSession` distinguishes a login/register (a
 * NEW session incarnation) from an access-token-ROTATION refresh — the caller
 * must say which, because the backend returns the SAME rich `user` shape on
 * login, register, AND refresh (`toUserResponse`), so the response body can't be
 * used to tell them apart.
 */
export function storeTokens(
  auth: AuthResponse,
  options?: { newSession?: boolean },
): void {
  // #279 / #501 — when the rider switching paths land here without
  // a prior `clearTokens()` (e.g. `LinkAccountScreen` going
  // straight from one bearer to another), wipe the cached privacy
  // preferences first so the new rider's `road_data_contribution`
  // gate doesn't read the previous rider's value during the brief
  // window before the fire-and-forget refresh lands.
  //
  // Clears on ANY non-matching persisted id, including the legacy
  // case where `USER_ID_KEY` is empty on an upgraded install but
  // the privacy cache survived from a pre-upgrade refresh — also
  // a stale-cache leak (Codex follow-up review on PR #513
  // r3212954097). Compared by user id, so a normal access-token
  // rotation (same rider) never churns the cache.
  const incomingUserId = auth.user?.id ?? null;
  if (incomingUserId) {
    const persistedUserId = storage.getString(USER_ID_KEY) ?? null;
    if (persistedUserId !== incomingUserId) {
      clearCachedPreferences();
    }
  }

  // KNOWN FINDING, tracked in #1231: these two writes put the backend tokens
  // into unencrypted MMKV. The suppressions exist so the security gate can
  // block NEW plaintext-credential sites while that issue owns this one; they
  // are removed with its fix.
  // nosemgrep: tarmoto-rn-secret-in-mmkv
  storage.set(ACCESS_TOKEN_KEY, auth.access_token);
  // nosemgrep: tarmoto-rn-secret-in-mmkv
  storage.set(REFRESH_TOKEN_KEY, auth.refresh_token);
  // The backend hands back the rich profile on login / register / refresh
  // alike, so update the persisted user id + cache whenever a user is present.
  if (incomingUserId) {
    setCachedUser(auth.user);
  }
  // Bump the session epoch ONLY for a login/register (an explicit new session).
  // A refresh ALSO carries a user but is a token rotation, so the caller passes
  // `newSession` — the epoch stays stable across rotation, letting an in-flight
  // `/users/me` survive it, while a re-login (even same account) advances it and
  // rejects a response that spanned the boundary. See `sessionEpoch`.
  if (options?.newSession) {
    sessionEpoch += 1;
  }
}

export function clearTokens(): void {
  storage.remove(ACCESS_TOKEN_KEY);
  storage.remove(REFRESH_TOKEN_KEY);
  storage.remove(USER_ID_KEY);
  storage.remove(CACHED_USER_KEY);
  // Logout / 401-invalidation ends the session incarnation — bump so an
  // in-flight publisher started before this can't publish into the next.
  sessionEpoch += 1;
  // #279 / #501 — every token-invalidation path (logout, refresh
  // 4xx) must also wipe the cached privacy preferences. (A refresh
  // network failure / timeout is transient and no longer clears —
  // see the refresh catch.) Otherwise a different rider
  // signing in on the same device after a silent session
  // invalidation would keep reading the previous rider's
  // `road_data_contribution` until the fire-and-forget refresh
  // succeeds — exactly the cross-account leak the cache is meant
  // to avoid (Codex review on PR #513 r3212924104). Centralising
  // the clear here means we can't add a new clearTokens caller
  // without picking up the privacy clear too.
  clearCachedPreferences();
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

/**
 * Stable identifier for the currently-authenticated rider (#279 /
 * #501). Rotated only on login / register / logout — NOT on
 * access-token refresh — so callers that need to detect "the
 * session changed mid-flight" can compare snapshots without false
 * positives from the refresh middleware silently issuing a new
 * access token.
 */
export function getAuthenticatedUserId(): string | null {
  return storage.getString(USER_ID_KEY) ?? null;
}

/**
 * Backfill helper for installs upgraded from a build that didn't
 * persist `user_id`. The `register` / `login` paths normally store
 * the id via `storeTokens(auth)`, but a rider already-signed-in at
 * upgrade time has access/refresh tokens in MMKV without the
 * companion id. The privacy refresh hook in `apiService` calls
 * this with the result of `/users/me` to populate the slot on the
 * first foreground after upgrade. Only writes — never clears — so
 * existing values are preserved.
 */
export function setAuthenticatedUserId(userId: string): void {
  if (userId) {
    storage.set(USER_ID_KEY, userId);
  }
}

/**
 * Runtime shape guard for the /auth/refresh body — the `openapi-fetch` types
 * don't validate at runtime, and a 2xx with empty/missing/mistyped tokens would
 * otherwise persist an unusable session. Requires BOTH tokens to be non-empty
 * strings (a rotated pair always carries both).
 */
function isValidAuthResponse(value: unknown): value is AuthResponse {
  if (typeof value !== "object" || value === null) return false;
  const { access_token, refresh_token } = value as Record<string, unknown>;
  return (
    typeof access_token === "string" &&
    access_token.length > 0 &&
    typeof refresh_token === "string" &&
    refresh_token.length > 0
  );
}

/**
 * Imperative refresh — POSTs the stored refresh token to /auth/refresh
 * via raw fetch (bypassing the typed-client middleware so the call
 * itself can't loop). Persists new tokens on success, clears them on
 * failure. Concurrent calls share a single inflight promise.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const sessionAtStart: StoredAuthSession = {
    accessToken: getAccessToken(),
    refreshToken,
    userId: getAuthenticatedUserId(),
  };

  inflightRefresh = (async () => {
    const handle = withTimeout(undefined, REQUEST_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(`${API_BASE_URL}${REFRESH_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: handle.signal,
        });
      } catch {
        // ONLY a transient fetch failure (timeout OR network) reaches here —
        // NOT an auth rejection. Keep the stored tokens so an offline rider (a
        // dead zone) stays signed in; the next request retries once
        // connectivity returns. Clearing would sign them out for a blip and,
        // because the entitlements monitor gates on `isAuthenticated()`,
        // silently stop refreshing too.
        return null;
      }
      if (!res.ok) {
        if (isStoredSessionCurrent(sessionAtStart)) clearTokens();
        return null;
      }
      // The server accepted the refresh, but the body may be malformed. Nothing
      // has been persisted yet, so a parse failure is like an unusable
      // rejection: clear the still-current session (a concurrent login is
      // protected by the guard) rather than retaining and retrying a broken one.
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        if (isStoredSessionCurrent(sessionAtStart)) clearTokens();
        return null;
      }
      // A syntactically valid body can still be contract-invalid — e.g. empty or
      // missing token fields. The `as AuthResponse` cast does NO runtime check,
      // and persisting empty credentials would replace a usable session with an
      // unusable one. Validate BOTH tokens are non-empty strings before touching
      // storage; otherwise treat it as a rejection and invalidate.
      if (!isValidAuthResponse(parsed)) {
        if (isStoredSessionCurrent(sessionAtStart)) clearTokens();
        return null;
      }
      const auth = parsed;
      // Login, registration, or logout may have replaced the session while
      // this refresh was in flight. Never let an old response overwrite (or
      // later clear) the newer rider's credentials.
      if (!isStoredSessionCurrent(sessionAtStart)) return null;
      try {
        storeTokens(auth);
      } catch {
        // A partial write of THIS session (storeTokens is synchronous, so no
        // concurrent login could have interleaved after the check above) — the
        // stored state is now mixed (e.g. new access, old refresh) and would
        // fail renewal forever. `isStoredSessionCurrent` no longer matches the
        // pre-write snapshot, so clear UNCONDITIONALLY to sign out cleanly
        // rather than leaving inconsistent credentials behind.
        clearTokens();
        return null;
      }
      return auth.access_token;
    } catch {
      // Any residual unexpected failure — invalidate the still-current session.
      if (isStoredSessionCurrent(sessionAtStart)) clearTokens();
      return null;
    } finally {
      handle.dispose();
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

const baseClient = createTarmotoClient({
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
    const locale = getRequestLanguage(detectDeviceLocale());
    const headers = new Headers(request.headers);
    if (locale && !headers.has("Accept-Language")) {
      headers.set("Accept-Language", locale);
    }
    const localizedRequest = new Request(request, { headers });

    if (
      localizedRequest.method !== "GET" &&
      localizedRequest.method !== "HEAD"
    ) {
      // Clone first — `arrayBuffer()` on the clone consumes the
      // clone's body stream while leaving the original request body
      // intact for the imminent fetch. The original then ships its
      // body normally.
      const buf = await localizedRequest.clone().arrayBuffer();
      if (buf.byteLength > 0) requestBodies.set(id, buf);
    }
    // Apply the 15 s deadline by replacing the request with one that
    // carries our combined signal. A caller-supplied signal (e.g.
    // `uploadReviewPhotos` cancellation) is preserved because
    // `withTimeout` propagates its abort.
    const handle = withTimeout(localizedRequest.signal, REQUEST_TIMEOUT_MS);
    requestTimeouts.set(id, handle);
    return new Request(localizedRequest, { signal: handle.signal });
  },
  async onResponse({ response, request, schemaPath, id }) {
    try {
      if (response.status !== 401) return response;
      if (SKIP_REFRESH_PATHS.includes(schemaPath)) return response;

      const refreshedToken = await refreshAccessToken();
      if (!refreshedToken) return response;

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
      const headers = new Headers();
      request.headers.forEach((value, key) => headers.set(key, value));
      headers.set("Authorization", `Bearer ${refreshedToken}`);

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

/** Test hooks for deterministic refresh-race coverage. */
export function __setAuthStorageForTest(next: AuthStorage): void {
  storage = next;
  inflightRefresh = null;
}

export const __refreshAccessTokenForTest = refreshAccessToken;

/**
 * Raw fetch escape hatch for endpoints that must bypass the typed
 * client and its refresh middleware. The only intentional caller is
 * `pushRegistration.unregisterPush` — see its comment for the
 * logout-loop rationale. Returns the Response so callers can check
 * `res.ok` themselves.
 */
export async function rawFetch(
  path: string,
  init: RequestInit & { bearer?: string | undefined },
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
