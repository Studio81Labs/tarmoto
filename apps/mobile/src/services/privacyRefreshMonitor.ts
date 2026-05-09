/**
 * Foreground-aware refresh of the privacy preferences cache
 * (#279 / #501 — Codex review on PR #513).
 *
 * The mobile-side `road_data_contribution` gate reads from the
 * synchronous `privacyCache` before each sensor upload. Without a
 * regular refresh, an already-authenticated install (or a rider who
 * toggles the preference from the companion while the mobile app
 * stays signed in) would keep returning the previous opt-in
 * defaults until the next login — defeating the client-side
 * "don't ship / don't burn battery" enforcement the cache exists
 * to provide.
 *
 * Strategy mirrors `commuteHazardNotifier`:
 *
 *   1. On `start()` — fire one refresh immediately (cold start).
 *   2. Subscribe to `AppState` 'active' transitions and refresh on
 *      each foreground.
 *   3. Skip refreshes when the rider isn't authenticated (no
 *      bearer to send) so a logged-out app doesn't churn against
 *      `/account/privacy`.
 *
 * Failures are swallowed: this is best-effort sync, the backend
 * still drops opted-out payloads server-side, and we don't want a
 * transient network blip to surface a UI error.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface PrivacyRefreshDeps {
  /** Returns true when the user is signed in. */
  isAuthenticated: () => boolean;
  /** Refresh the privacy preferences cache (typically `api.refreshPrivacyPreferences`). */
  refresh: () => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;

/**
 * Start the foreground/startup privacy refresh monitor. Returns a
 * cleanup that's safe to call multiple times.
 */
export function startPrivacyRefreshMonitor(
  deps: PrivacyRefreshDeps,
): () => void {
  // Drop a prior subscription (e.g. from a hot reload) so we don't
  // accumulate duplicate handlers.
  stopPrivacyRefreshMonitor();

  // Cold-start refresh. Fire-and-forget — caller is a mount effect
  // and can't await us. `refreshIfAuthenticated` no-ops for a
  // logged-out app so we don't pin a network request to login flow.
  void refreshIfAuthenticated(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void refreshIfAuthenticated(deps);
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  // Bind the cleanup to *this specific* subscription so a stale
  // closure (from a hot reload or a second start() call) can't tear
  // down a newer listener.
  return () => {
    if (monitorSubscription === subscription) {
      stopPrivacyRefreshMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopPrivacyRefreshMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function refreshIfAuthenticated(deps: PrivacyRefreshDeps): Promise<void> {
  if (!deps.isAuthenticated()) return;
  try {
    await deps.refresh();
  } catch {
    // Best-effort sync — backend still drops opted-out payloads
    // server-side, so a transient refresh failure isn't worth a
    // toast or a retry loop. The next foreground transition tries
    // again.
  }
}
