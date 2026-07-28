/**
 * Foreground-aware refresh of the operator system-switch cache
 * (`sys_accel_collection` and the rest of `/config/flags`).
 *
 * The mobile-side accelerometer/gyro kill switch reads the SYNCHRONOUS
 * `systemSwitchCache` at ride start. Without a regular refresh, an
 * already-running install would keep sampling on whatever operator state was
 * cached at the previous launch — so an operator flipping `sys_accel_collection`
 * to `force_off` (a data-pipeline or privacy incident kill) wouldn't take effect
 * on that phone until its next cold start. This monitor re-pulls `/config/flags`
 * on cold start and on every foreground so the next ride honours the live state.
 *
 * Strategy mirrors `privacyRefreshMonitor`, with ONE deliberate difference:
 * `/config/flags` is a PUBLIC endpoint (operator kill switches apply to signed-
 * out riders too — a logged-out phone still runs the accelerometer on the record
 * screen), so there is NO authentication gate. A cold start refreshes
 * immediately regardless of auth state.
 *
 * Failures are swallowed: this is best-effort sync. On a failed refresh the
 * cache keeps its previous value (fail SAFE — the switch defaults ON), and the
 * next foreground transition tries again.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface SystemSwitchRefreshDeps {
  /** Pull the latest `/config/flags` override map and persist it to the cache. */
  refresh: () => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;

/**
 * Start the foreground/startup system-switch refresh monitor. Returns a cleanup
 * that's safe to call multiple times.
 */
export function startSystemSwitchRefreshMonitor(
  deps: SystemSwitchRefreshDeps,
): () => void {
  // Drop a prior subscription (e.g. from a hot reload) so we don't accumulate
  // duplicate handlers.
  stopSystemSwitchRefreshMonitor();

  // Cold-start refresh — no auth gate, `/config/flags` is public.
  void refreshQuietly(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void refreshQuietly(deps);
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  // Bind cleanup to *this specific* subscription so a stale closure (hot reload
  // or a second start() call) can't tear down a newer listener.
  return () => {
    if (monitorSubscription === subscription) {
      stopSystemSwitchRefreshMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopSystemSwitchRefreshMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function refreshQuietly(deps: SystemSwitchRefreshDeps): Promise<void> {
  try {
    await deps.refresh();
  } catch {
    // Best-effort sync — the cache keeps its last value (fail SAFE, switch
    // defaults ON), and the next foreground transition retries.
  }
}
