/**
 * One-shot entitlement refresh with the app's standard wiring.
 *
 * Screens call `refreshEntitlementsNow()` after a reactive limit 403 so the
 * resolved tier is current before an UpgradePrompt derives its upgrade target
 * — a stale cached tier (e.g. Pro after a server-side downgrade to Free) would
 * otherwise be compared against the wrong tier default and hide a valid
 * upgrade. Fire-and-forget: the single-writer refresh in `authBootstrap`
 * handles ordering, and callers just want the store to catch up.
 *
 * The deps mirror App.tsx's `startEntitlementsRefreshMonitor` wiring.
 */
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { refreshEntitlements } from "@/services/authBootstrap";

export function refreshEntitlementsNow(): void {
  void refreshEntitlements({
    getSessionSnapshot: () => api.getAuthSessionSnapshot(),
    getProfile: () => api.getProfile(),
    getCurrentUser: () => useAuthStore.getState().user,
    setUser: useAuthStore.getState().setUser,
    cacheProfile: (profile) => api.cacheProfile(profile),
  });
}
