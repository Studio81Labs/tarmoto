/**
 * Foreground-aware refresh of the cached entitlement snapshot
 * (`subscription_tier` / `features` / `limits` on the auth-store user).
 *
 * The mobile gates (road-quality overlay zoom, GPX export) read the
 * entitlement snapshot straight from the auth store, which is populated
 * ONCE by the cold-start `bootstrapAuth`. Without a periodic refresh, an
 * install that stays signed in would keep enforcing the snapshot captured
 * at launch: if an operator removes a launch-mode unlimited override,
 * force-disables a feature, or downgrades a rider mid-session, the stale
 * `road_quality_max_zoom: null` would keep the client-only overlay
 * rendering through the source ceiling until the next login. The overlay
 * is a client-enforced monetization boundary, so it must re-check the
 * server the same way the `road_data_contribution` privacy gate does.
 *
 * Strategy mirrors `privacyRefreshMonitor`:
 *
 *   1. On `start()` — fire one refresh immediately (cold start). The
 *      cold-start `bootstrapAuth` also runs, but this keeps the monitor
 *      self-contained and idempotent.
 *   2. Subscribe to `AppState` 'active' transitions and refresh on each
 *      foreground (covers a rider resumed from background after an
 *      operator-side change).
 *   3. Skip refreshes when the rider isn't authenticated so a logged-out
 *      app doesn't churn against `/users/me`.
 *
 * Failures are swallowed: the previous snapshot stays in place (the gates
 * still fail closed against it), and the next foreground transition tries
 * again. A transient network blip must not blank the rider's session or
 * surface a UI error.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface EntitlementsRefreshDeps {
  /** Returns true when the user is signed in. */
  isAuthenticated: () => boolean;
  /** Re-fetch `/users/me` and republish the entitlement snapshot to the
   *  auth store (typically re-running `bootstrapAuth`). */
  refresh: () => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;

/**
 * Start the foreground/startup entitlements refresh monitor. Returns a
 * cleanup that's safe to call multiple times.
 */
export function startEntitlementsRefreshMonitor(
  deps: EntitlementsRefreshDeps,
): () => void {
  // Drop a prior subscription (e.g. from a hot reload) so we don't
  // accumulate duplicate handlers.
  stopEntitlementsRefreshMonitor();

  // Cold-start refresh. Fire-and-forget — caller is a mount effect and
  // can't await us. `refreshIfAuthenticated` no-ops for a logged-out app.
  void refreshIfAuthenticated(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void refreshIfAuthenticated(deps);
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  // Bind the cleanup to *this specific* subscription so a stale closure
  // (from a hot reload or a second start() call) can't tear down a newer
  // listener.
  return () => {
    if (monitorSubscription === subscription) {
      stopEntitlementsRefreshMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopEntitlementsRefreshMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function refreshIfAuthenticated(
  deps: EntitlementsRefreshDeps,
): Promise<void> {
  if (!deps.isAuthenticated()) return;
  try {
    await deps.refresh();
  } catch {
    // Best-effort sync — the previous snapshot stays in place and the
    // gates still fail closed against it, so a transient refresh failure
    // isn't worth a toast or a retry loop. The next foreground transition
    // tries again.
  }
}
