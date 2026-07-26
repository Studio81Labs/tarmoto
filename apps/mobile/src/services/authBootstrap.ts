import type { User } from "@/types";

export interface AuthSessionSnapshot {
  accessToken: string;
  userId: string | null;
}

export interface AuthBootstrapDependencies {
  getSessionSnapshot: () => AuthSessionSnapshot | null;
  getCachedProfile: () => User | null;
  getProfile: () => Promise<User>;
  /** The profile CURRENTLY in the auth store, read at publish time. */
  getCurrentUser: () => User | null;
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
// generation it bumped to and refuses to CLOBBER an existing user once a later
// call has bumped past it: only the latest-STARTED refresh reaches an already
// populated store. The one exception — shared by both publishers — is an EMPTY
// store: supersession protects a fresher snapshot from an older one, and an
// empty store has nothing to protect, so a superseded-but-validated response
// still establishes the baseline (checked via `getCurrentUser()` at publish
// time, so it is correct regardless of which request resolves first).
let latestBootstrapGeneration = 0;

/** Whether a superseded response must yield: only when the store already holds a
 *  user (a fresher publish we must not clobber). With an empty store the
 *  superseded response establishes the baseline instead of deadlocking. */
function supersededShouldYield(
  generation: number,
  current: User | null,
): boolean {
  return generation !== latestBootstrapGeneration && current !== null;
}

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
    if (
      !isCurrentAuthSession(initialSession, deps.getSessionSnapshot(), profile)
    ) {
      deps.setLoading(false);
      return;
    }
    // A later refresh started while this was in flight — drop only if it has
    // already populated the store (don't clobber the fresher snapshot). With an
    // empty store, publish this validated response as the baseline so a failed
    // superseding refresh can't strand the app in auth loading.
    if (supersededShouldYield(generation, deps.getCurrentUser())) {
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
 * as signed out — otherwise the stale user lingers, `isAuthenticated()` is false
 * so the monitor stops refreshing, and the app is stuck on protected screens
 * until restart. Nothing is published if the rider logged out or switched
 * accounts while the GET was in flight.
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
    // A 401 whose token refresh failed clears the session before the GET
    // rejects → sign out. A network blip with the session intact retains
    // last-known-good (offline-first). No generation manipulation: a stranded
    // in-flight bootstrap now recovers via the empty-store baseline rule below,
    // regardless of which request resolves first.
    if (!deps.getSessionSnapshot()) deps.setUser(null);
    return;
  }

  if (!isCurrentAuthSession(initialSession, deps.getSessionSnapshot(), profile))
    return;

  const current = deps.getCurrentUser();
  // A live profile for a DIFFERENT rider means an account switch landed
  // mid-refresh — drop rather than clobber the new rider.
  if (current && current.id !== profile.id) return;

  // Superseded by a later refresh — drop only if the store already holds a user
  // (don't clobber the fresher snapshot). With an EMPTY store, establish the
  // baseline from this validated response instead of deadlocking.
  if (supersededShouldYield(generation, current)) return;

  // With a live same-rider profile, overlay ONLY the entitlement slices so a
  // PATCH that landed while the GET was in flight keeps its fields. With no live
  // profile yet — an authenticated cold start whose cache was empty/corrupt,
  // foregrounded before `bootstrapAuth` finished — publish the full validated
  // response as the baseline.
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
