import type { User } from "@/types";

export interface AuthBootstrapDependencies {
  isAuthenticated: () => boolean;
  getCachedProfile: () => User | null;
  getProfile: () => Promise<User>;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
}

/** Hydrate the persisted rider immediately, then refresh it from the API. */
export async function bootstrapAuth(
  deps: AuthBootstrapDependencies,
): Promise<void> {
  if (!deps.isAuthenticated()) {
    deps.setUser(null);
    return;
  }

  const cached = deps.getCachedProfile();
  if (cached) deps.setUser(cached);

  try {
    deps.setUser(await deps.getProfile());
  } catch {
    // The 401 refresh path clears invalid tokens. Network-only failures retain
    // the cached profile so an authenticated rider can keep using offline UI.
    if (!deps.isAuthenticated()) deps.setUser(null);
    else deps.setLoading(false);
  }
}
