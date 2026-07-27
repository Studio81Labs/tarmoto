/**
 * One-shot entitlement refresh with the app's standard wiring.
 *
 * Screens `await refreshEntitlementsNow()` after a reactive limit 403 so the
 * resolved tier is current BEFORE an UpgradePrompt derives its upgrade target
 * — a stale cached tier (e.g. Pro after a server-side downgrade to Free) would
 * otherwise be compared against the wrong tier default and hide a valid
 * upgrade. Resolves (never rejects) once the store has caught up; the
 * single-writer refresh in `authBootstrap` handles ordering.
 *
 * The deps mirror App.tsx's `startEntitlementsRefreshMonitor` wiring.
 */
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { refreshEntitlements } from "@/services/authBootstrap";

export function refreshEntitlementsNow(): Promise<void> {
  return refreshEntitlements({
    getSessionSnapshot: () => api.getAuthSessionSnapshot(),
    getProfile: () => api.getProfile(),
    getCurrentUser: () => useAuthStore.getState().user,
    setUser: useAuthStore.getState().setUser,
    cacheProfile: (profile) => api.cacheProfile(profile),
    // Never reject: the caller only wants the tier updated if possible, then
    // opens the prompt regardless (a refresh failure leaves the prior tier,
    // which is no worse than before this call existed).
  }).catch(() => undefined);
}
