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

function isCurrentSession(
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

/** Hydrate the persisted rider immediately, then refresh it from the API. */
export async function bootstrapAuth(
  deps: AuthBootstrapDependencies,
): Promise<void> {
  const initialSession = deps.getSessionSnapshot();
  if (!initialSession) {
    deps.setUser(null);
    return;
  }

  const cached = deps.getCachedProfile();
  if (cached) deps.setUser(cached);

  try {
    const profile = await deps.getProfile();
    if (!isCurrentSession(initialSession, deps.getSessionSnapshot(), profile)) {
      deps.setLoading(false);
      return;
    }
    deps.cacheProfile(profile);
    deps.setUser(profile);
  } catch {
    // The 401 refresh path clears invalid tokens. Network-only failures retain
    // the cached profile so an authenticated rider can keep using offline UI.
    if (!deps.getSessionSnapshot()) deps.setUser(null);
    else deps.setLoading(false);
  }
}
