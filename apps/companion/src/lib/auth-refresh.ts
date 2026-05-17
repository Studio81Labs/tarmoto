import { API_BASE_SERVER } from "@/lib/config";
import type { BackendAuthResponse } from "@/lib/social-auth-bridge";

/**
 * Calls the backend `/auth/refresh` endpoint, returning the new
 * access + refresh tokens. Throws when the refresh token is
 * invalid, the backend is unreachable, or the refresh-rate limit
 * trips.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<BackendAuthResponse> {
  const res = await fetch(`${API_BASE_SERVER}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) throw new Error("Token refresh failed");
  return res.json() as Promise<BackendAuthResponse>;
}

/**
 * Process-local refresh dedup. When a user has multiple companion
 * tabs open they each poll `/api/auth/session` every 4 min; if
 * several land on the JWT callback within the 5 min refresh window
 * each would otherwise call `/auth/refresh` and:
 *
 *   - burn the refresh token via parallel rotation (the backend
 *     consumes it on first use, so the second caller gets a 401),
 *   - or trip the backend's 5 req/min refresh rate limit and
 *     surface a 429 as `RefreshTokenError`, which would cascade
 *     into `signOut` and yank every other tab to /login.
 *
 * Sharing the in-flight promise keyed by user id collapses all
 * concurrent attempts into one backend round-trip. Multi-instance
 * Coolify replicas still serialize per-process, not globally, but
 * per-process dedup eliminates the realistic within-browser storm.
 *
 * The grace window keeps the entry around briefly after the
 * promise settles so a tab that read the *old* cookie just before
 * the new one was committed still joins this refresh instead of
 * racing the backend with the consumed refresh token.
 */
const REFRESH_GRACE_MS = 1_000;

interface DedupOptions {
  /**
   * Replaces the underlying refresh function — only used by tests
   * to avoid stubbing global fetch. Defaults to the real
   * `refreshAccessToken`.
   */
  refresh?: (refreshToken: string) => Promise<BackendAuthResponse>;
  /**
   * Grace window in ms before a settled entry is evicted. Tests
   * pass `0` to make eviction synchronous.
   */
  graceMs?: number;
}

const inflight = new Map<string, Promise<BackendAuthResponse>>();

export function dedupedRefresh(
  userId: string,
  refreshToken: string,
  options: DedupOptions = {},
): Promise<BackendAuthResponse> {
  const { refresh = refreshAccessToken, graceMs = REFRESH_GRACE_MS } = options;
  const existing = inflight.get(userId);
  if (existing) return existing;
  const promise = refresh(refreshToken);
  inflight.set(userId, promise);
  const scheduleEviction = () => {
    if (graceMs === 0) {
      if (inflight.get(userId) === promise) inflight.delete(userId);
      return;
    }
    setTimeout(() => {
      if (inflight.get(userId) === promise) inflight.delete(userId);
    }, graceMs);
  };
  // `.then(_, _)` (not `.finally`) so a rejection from `refresh`
  // doesn't bubble out of this side-effect chain as an unhandled
  // rejection — callers of `dedupedRefresh` get the rejection
  // through their own `await` on the returned promise.
  promise.then(scheduleEviction, scheduleEviction);
  return promise;
}

/**
 * Test helper — flush all cached in-flight refreshes. Lets unit
 * tests reset module state between cases without restarting the
 * worker.
 */
export function _resetRefreshDedupForTests(): void {
  inflight.clear();
}
