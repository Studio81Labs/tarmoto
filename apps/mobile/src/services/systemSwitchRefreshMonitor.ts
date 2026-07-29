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
 *
 * Concurrent refreshes are ordered by a monotonic generation guard: a cold-
 * start fetch can still be in flight when a foreground transition kicks off a
 * newer one, and the two can resolve out of order. A fetch publishes only if
 * its generation is newer than the last one that actually PUBLISHED — so a
 * slow older response can't overwrite the cache with a stale map (which would
 * silently re-enable a subsystem an operator just `force_off`'d), yet a valid
 * older response is still honoured when a newer fetch FAILED without
 * publishing. Gating on last-started instead would let a failed newer request
 * suppress a good older one, leaving the cache stale.
 */

import { AppState, type AppStateStatus } from "react-native";

import type { GlobalFeatureStates } from "@tarmoto/shared";

export interface SystemSwitchRefreshDeps {
  /** Pull the latest `/config/flags` operator override map. */
  fetchStates: () => Promise<GlobalFeatureStates>;
  /** Persist a freshly-fetched override map to the synchronous cache. */
  persist: (states: GlobalFeatureStates) => void;
}

let monitorSubscription: { remove: () => void } | null = null;
// Monotonic across every refresh this module starts. Bumped when a fetch
// begins, so each in-flight fetch carries a unique, ordered generation.
let refreshGeneration = 0;
// The generation of the newest fetch that has actually published. A result
// publishes only if it is newer than this — so a failed newer fetch (which
// never advances it) can't suppress a valid older result.
let lastPublishedGeneration = 0;

// Cold start + foreground transitions alone leave a long-foregrounded session
// (an active ride / navigation) on whatever `/config/flags` was cached at
// launch — an operator flipping an incident kill switch wouldn't reach the app
// until the rider backgrounds and reopens it. So also poll while foregrounded.
// These are immediate safety kill switches (e.g. `crash_detection` arming false
// SOS dispatch), and the endpoint advertises `Cache-Control: max-age=60`, so
// poll at that same 60s freshness window rather than lagging minutes behind an
// operator kill. Paused when not `active` so a backgrounded app doesn't churn
// the network.
const POLL_INTERVAL_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(deps: SystemSwitchRefreshDeps): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    void refreshQuietly(deps);
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

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
  // Cold start is a foreground moment — begin polling immediately.
  startPolling(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void refreshQuietly(deps);
      startPolling(deps);
    } else {
      // Backgrounded / inactive — stop polling; the next `active` transition
      // fires an immediate refresh and restarts the timer.
      stopPolling();
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
  stopPolling();
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
}

async function refreshQuietly(deps: SystemSwitchRefreshDeps): Promise<void> {
  const generation = ++refreshGeneration;
  try {
    const states = await deps.fetchStates();
    // Publish only if a newer fetch hasn't already published. This drops a
    // slow older result that lost the race, but still honours this result
    // when a newer fetch failed (it never advanced `lastPublishedGeneration`).
    if (generation <= lastPublishedGeneration) return;
    lastPublishedGeneration = generation;
    deps.persist(states);
  } catch {
    // Best-effort sync — the cache keeps its last value (fail SAFE, switch
    // defaults ON), and the next foreground transition retries.
  }
}
