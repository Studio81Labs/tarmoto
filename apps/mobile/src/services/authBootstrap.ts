import type { User } from "@/types";

export interface AuthSessionSnapshot {
  accessToken: string;
  userId: string | null;
}

export interface AuthBootstrapDependencies {
  getSessionSnapshot: () => AuthSessionSnapshot | null;
  getCachedProfile: () => User | null;
  getProfile: () => Promise<User>;
  cacheProfile: (user: User) => void;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
}

export function isCurrentAuthSession(
  initial: AuthSessionSnapshot,
  current: AuthSessionSnapshot | null,
  profile: User,
): boolean {
  if (!current) return false;

  if (initial.userId) {
    return current.userId === initial.userId && profile.id === initial.userId;
  }

  // Upgraded installs can have tokens without a persisted user id. A login or
  // registration always fills that id, so use it to reject an old /users/me
  // response after an account switch. If no id has appeared, require the
  // original bearer token; a refresh rotation may defer hydration until the
  // next attempt, but can never publish or persist the wrong rider.
  if (current.userId) return current.userId === profile.id;
  return current.accessToken === initial.accessToken;
}

// Monotonic generation stamp shared by both `/users/me` publishers here — the
// cold-start `bootstrapAuth` and the foreground `refreshEntitlements`. When two
// overlap (a foreground while a prior GET is still in flight), their responses
// can resolve out of order; without an ordering guard an older, slow response
// would overwrite a newer downgrade / force-off snapshot and restore
// client-only access until the next successful refresh. Each call captures the
// generation it bumped to and refuses to publish once a later call has bumped
// past it: only the latest-STARTED refresh (which read the freshest server
// state) ever reaches the auth store.
let latestBootstrapGeneration = 0;

/** Hydrate the persisted rider immediately, then refresh it from the API. */
export async function bootstrapAuth(
  deps: AuthBootstrapDependencies,
): Promise<void> {
  const generation = ++latestBootstrapGeneration;
  const initialSession = deps.getSessionSnapshot();
  if (!initialSession) {
    deps.setUser(null);
    return;
  }

  const cached = deps.getCachedProfile();
  if (cached) deps.setUser(cached);

  try {
    const profile = await deps.getProfile();
    // A later refresh started while this one was in flight — its response
    // reflects newer server state, so drop this (possibly stale) one rather
    // than letting an out-of-order resolve clobber the fresher snapshot.
    if (generation !== latestBootstrapGeneration) return;
    if (
      !isCurrentAuthSession(initialSession, deps.getSessionSnapshot(), profile)
    ) {
      deps.setLoading(false);
      return;
    }
    deps.cacheProfile(profile);
    deps.setUser(profile);
  } catch {
    // The 401 refresh path clears invalid tokens. Network-only failures retain
    // the cached profile so an authenticated rider can keep using offline UI.
    // Superseded failures do nothing — the latest refresh owns the outcome.
    if (generation !== latestBootstrapGeneration) return;
    if (!deps.getSessionSnapshot()) deps.setUser(null);
    else deps.setLoading(false);
  }
}

export interface EntitlementsRefreshDependencies {
  getSessionSnapshot: () => AuthSessionSnapshot | null;
  getProfile: () => Promise<User>;
  /** The profile CURRENTLY in the auth store, read at publish time. */
  getCurrentUser: () => User | null;
  setUser: (user: User | null) => void;
  cacheProfile: (user: User) => void;
}

/**
 * Refresh ONLY the server-controlled entitlement slices (`subscription_tier` /
 * `features` / `limits`) from `/users/me`, merging them into the CURRENT live
 * profile. The foreground monitor uses this instead of a full `bootstrapAuth`
 * because a full re-publish would clobber a concurrent profile/preference
 * PATCH: if the rider toggles a setting right after resuming and that PATCH
 * resolves while this GET is still in flight, publishing the whole GET response
 * would overwrite the just-saved field with its stale copy. Reading the live
 * profile at publish time (not fetch time) and overlaying only the entitlement
 * slices preserves any such concurrent edit. Ordering against other refreshes
 * still goes through the shared generation guard; the rider's own PATCH wins on
 * the fields it owns because we never overwrite them.
 *
 * Best-effort: on a NETWORK failure the previous snapshot is retained
 * (offline-first — see `entitlementsRefreshMonitor`). But a 401 whose token
 * refresh fails clears the session (`clearTokens`) before the GET rejects; in
 * that case we publish `null` so navigation and the monitor both see the rider
 * as signed out — otherwise the stale user lingers, `isAuthenticated()` is
 * false so the monitor stops refreshing, and the app is stuck on protected
 * screens until restart. Nothing is published if the rider logged out or
 * switched accounts while the GET was in flight.
 */
export async function refreshEntitlements(
  deps: EntitlementsRefreshDependencies,
): Promise<void> {
  const generation = ++latestBootstrapGeneration;
  const initialSession = deps.getSessionSnapshot();
  if (!initialSession) return;

  let profile: User;
  try {
    profile = await deps.getProfile();
  } catch {
    // Session gone (401 → tokens cleared) → sign out; session intact (network
    // blip) → retain last known good. Skip if a later refresh superseded us.
    if (
      generation === latestBootstrapGeneration &&
      !deps.getSessionSnapshot()
    ) {
      deps.setUser(null);
    }
    return;
  }

  // Superseded by a later refresh, or the session changed under us.
  if (generation !== latestBootstrapGeneration) return;
  if (!isCurrentAuthSession(initialSession, deps.getSessionSnapshot(), profile))
    return;

  const current = deps.getCurrentUser();
  // A live profile for a DIFFERENT rider means an account switch landed
  // mid-refresh — drop rather than clobber the new rider.
  if (current && current.id !== profile.id) return;

  // With a live same-rider profile, overlay ONLY the entitlement slices so a
  // PATCH that landed while the GET was in flight keeps its fields. With NO
  // live profile yet — an authenticated cold start whose cache was empty or
  // corrupt, foregrounded before `bootstrapAuth` finished — establish the
  // baseline from this already session-validated response. Otherwise bootstrap
  // drops its now-superseded response and neither publisher populates the
  // store, leaving the app stuck in auth loading.
  const merged: User = current
    ? {
        ...current,
        subscription_tier: profile.subscription_tier,
        features: profile.features,
        limits: profile.limits,
      }
    : profile;
  deps.setUser(merged);
  deps.cacheProfile(merged);
}
