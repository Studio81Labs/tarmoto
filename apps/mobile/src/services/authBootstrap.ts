import type { User } from "@/types";

export interface AuthSessionSnapshot {
  accessToken: string;
  userId: string | null;
  /** Session incarnation — changes on login/logout, stable across token
   *  rotation (see typedClient `sessionEpoch`). Distinguishes a re-login to the
   *  same account (which userId alone can't). */
  epoch: number;
}

export interface AuthBootstrapDependencies {
  getSessionSnapshot: () => AuthSessionSnapshot | null;
  getCachedProfile: () => User | null;
  getProfile: () => Promise<User>;
  cacheProfile: (user: User) => void;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  /** Marks the cold-start bootstrap as SETTLED (reactive store flag). Called on
   *  every terminal path so a screen gated on settlement re-renders. */
  markSettled: () => void;
}

export function isCurrentAuthSession(
  initial: AuthSessionSnapshot,
  current: AuthSessionSnapshot | null,
  profile: User,
): boolean {
  if (!current) return false;

  // A logout→login (even to the SAME account) starts a new session incarnation.
  // userId alone can't detect it, so reject a response that spanned the boundary
  // before it clobbers the fresher login snapshot. The epoch is stable across
  // token rotation, so a normal in-flight refresh is unaffected.
  if (current.epoch !== initial.epoch) return false;

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

// Both `/users/me` publishers here — the cold-start `bootstrapAuth` and the
// foreground `refreshEntitlements` — can overlap (a foreground while a prior GET
// is still in flight) and resolve out of order. To keep the freshest response
// authoritative without stranding anything, each call claims a strictly
// increasing generation at start, and we track the highest generation that has
// actually PUBLISHED. A resolved response yields only if a LATER generation has
// already published (never clobber a fresher snapshot). Because the high-water
// mark rises on PUBLISH — not on claim — a later request that FAILS never
// supersedes an earlier success, and the check is order-independent (evaluated
// when each response resolves). An empty store needs no special case: the first
// success to resolve simply has the highest published generation and
// establishes the baseline.
let generationCounter = 0;
let lastPublishedGeneration = 0;

/** True if a later-generation response has ALREADY published — this (older)
 *  result must yield rather than clobber the fresher one. */
function hasNewerPublish(generation: number): boolean {
  return generation < lastPublishedGeneration;
}

/** Raise the published high-water mark to this generation. */
function recordPublish(generation: number): void {
  if (generation > lastPublishedGeneration)
    lastPublishedGeneration = generation;
}

// Settlement is tracked as REACTIVE store state (`useAuthStore.bootstrapSettled`)
// so a screen that mounted before a sessionless bootstrap finished re-renders
// when it settles. `bootstrapAuth` marks it via the injected `markSettled` dep
// (kept dependency-injected so this module needn't import the store — that
// would drag the store's MMKV init into every `api` consumer). React components
// subscribe to `useAuthStore((s) => s.bootstrapSettled)`; non-React callers read
// `useAuthStore.getState().bootstrapSettled` at the call site. Deliberately
// distinct from `isLoading`, which the optimistic `setUser(cached)` clears early
// (instant offline display) before the baseline request lands.

/** Hydrate the persisted rider immediately, then refresh it from the API. */
export async function bootstrapAuth(
  deps: AuthBootstrapDependencies,
): Promise<void> {
  try {
    const generation = ++generationCounter;
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
        !isCurrentAuthSession(
          initialSession,
          deps.getSessionSnapshot(),
          profile,
        )
      ) {
        deps.setLoading(false);
        return;
      }
      // A later refresh already published a fresher snapshot — don't clobber it.
      // (A superseding request that failed never raised the mark, so this
      // baseline still wins and the app never strands in auth loading.)
      if (hasNewerPublish(generation)) {
        deps.setLoading(false);
        return;
      }
      recordPublish(generation);
      deps.cacheProfile(profile);
      deps.setUser(profile);
    } catch {
      // A newer response already published — it owns the outcome; don't let this
      // older failure override it.
      if (hasNewerPublish(generation)) return;
      // The 401 refresh path clears invalid tokens. Network-only failures retain
      // the cached profile so an authenticated rider can keep using offline UI.
      if (!deps.getSessionSnapshot()) deps.setUser(null);
      else deps.setLoading(false);
    }
  } finally {
    // Every terminal path (no session, publish, discard, failure) settles the
    // baseline — reactive, so a settlement-gated screen re-renders.
    deps.markSettled();
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
 * goes through the shared published high-water mark; the rider's own PATCH wins
 * on the fields it owns because we never overwrite them.
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
  const generation = ++generationCounter;
  const initialSession = deps.getSessionSnapshot();
  if (!initialSession) return;

  let profile: User;
  try {
    profile = await deps.getProfile();
  } catch {
    // A 401 whose token refresh failed clears the session before the GET
    // rejects → sign out. A network blip with the session intact retains
    // last-known-good (offline-first). A failed refresh never raises the
    // published mark, so an earlier in-flight success still wins.
    if (!deps.getSessionSnapshot()) deps.setUser(null);
    return;
  }

  if (!isCurrentAuthSession(initialSession, deps.getSessionSnapshot(), profile))
    return;

  const current = deps.getCurrentUser();
  // A live profile for a DIFFERENT rider means an account switch landed
  // mid-refresh — drop rather than clobber the new rider.
  if (current && current.id !== profile.id) return;

  // A later refresh already published a fresher snapshot — yield. (A superseding
  // request that failed never raised the mark, so an earlier success like this
  // one still publishes.)
  if (hasNewerPublish(generation)) return;
  recordPublish(generation);

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
