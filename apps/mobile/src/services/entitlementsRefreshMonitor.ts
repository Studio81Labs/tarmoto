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
 * Strategy mirrors `privacyRefreshMonitor`, minus the cold-start fire:
 *
 *   1. Foreground-only. The app's cold-start `bootstrapAuth` already
 *      refreshes at launch, so firing here too would just race that same
 *      request (two overlapping `/users/me` calls); this monitor only adds
 *      the ongoing foreground behaviour on top of that launch refresh.
 *   2. Subscribe to `AppState` 'active' transitions and refresh on each
 *      foreground (covers a rider resumed from background after an
 *      operator-side change).
 *   3. Skip refreshes when the rider isn't authenticated so a logged-out
 *      app doesn't churn against `/users/me`.
 *
 * Overlapping refreshes (two quick foregrounds, or a foreground during the
 * still-pending launch bootstrap) are made safe by `bootstrapAuth`'s
 * generation guard, which drops a superseded response before it publishes.
 *
 * Failures are swallowed and the previous snapshot is retained (last known
 * good) — a DELIBERATE offline-first choice, not a fail-closed one. Tarmoto
 * riders are frequently in dead zones, and blanking entitlements on a failed
 * refresh would strip the road-quality overlay / GPX export in exactly the
 * remote areas the app exists for. It also keeps the launch (dark) behaviour
 * byte-identical: every rider currently resolves to unlimited, so a flaky
 * network must not knock offline riders down to the free caps. A real
 * downgrade / force-off is still applied deterministically — the success path
 * (this monitor's foreground refresh + `bootstrapAuth`'s generation guard)
 * publishes it the moment the server is reachable and responds; only an
 * unreachable or erroring server delays a revocation, and the next foreground
 * transition retries. A transient blip must never blank the rider's session
 * or surface a UI error.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface EntitlementsRefreshDeps {
  /** Returns true when the user is signed in. */
  isAuthenticated: () => boolean;
  /** Re-fetch `/users/me` and merge the entitlement slices into the live
   *  profile (typically `refreshEntitlements`). */
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
