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

// Monotonic generation stamp shared by every `bootstrapAuth` caller (the
// cold-start effect AND the foreground entitlements refresh monitor). When two
// refreshes overlap — a foreground transition while a prior `/users/me` is
// still in flight, or the monitor racing the cold-start bootstrap — their
// responses can resolve out of order. Without an ordering guard an older, slow
// response would overwrite a newer downgrade / force-off snapshot and restore
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
