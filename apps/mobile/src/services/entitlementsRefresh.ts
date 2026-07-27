/**
 * One-shot entitlement refresh with the app's standard wiring.
 *
 * Screens `await refreshEntitlementsNow()` after a reactive limit 403 so the
 * resolved tier is current BEFORE an UpgradePrompt derives its upgrade target
 * — a stale cached tier (e.g. Pro after a server-side downgrade to Free) would
 * otherwise be compared against the wrong tier default and hide a valid
 * upgrade. The single-writer refresh in `authBootstrap` handles ordering.
 *
 * Returns whether the refresh SUCCEEDED (never rejects). Callers must not open
 * a tier-derived prompt on `false`: a failed refresh leaves a possibly-stale
 * snapshot, so rendering the prompt from it would reproduce the exact dead-end
 * (e.g. a cached Pro/Premium rider shown neutral "not available" copy) this
 * refresh exists to prevent. On `false`, keep the prompt pending and surface a
 * retryable error instead.
 *
 * The deps mirror App.tsx's `startEntitlementsRefreshMonitor` wiring.
 */
import { api } from "@/services/api";
import { useAuthStore } from "@/stores";
import { refreshEntitlements } from "@/services/authBootstrap";

export function refreshEntitlementsNow(): Promise<boolean> {
  return refreshEntitlements({
    getSessionSnapshot: () => api.getAuthSessionSnapshot(),
    getProfile: () => api.getProfile(),
    getCurrentUser: () => useAuthStore.getState().user,
    setUser: useAuthStore.getState().setUser,
    cacheProfile: (profile) => api.cacheProfile(profile),
  })
    .then(() => true)
    .catch(() => false);
}
