/**
 * Foreground/startup device-timezone sync (#866 — Codex review on PR #933).
 *
 * The weekly-digest dispatcher reads each rider's timezone from
 * `notification_preferences.quiet_hours_timezone` to send at their local
 * Sunday 08:00. Mobile riders never wrote that field, so they defaulted to UTC
 * and received the now-real digest at 08:00 UTC with a UTC-bucketed ride
 * window. This mirrors `privacyRefreshMonitor`:
 *
 *   1. On `start()` — fire once immediately (cold start).
 *   2. Subscribe to `AppState` 'active' transitions and fire on each
 *      foreground — catches a rider who crosses a timezone mid-session and a
 *      just-completed sign-in.
 *   3. Skip when signed out (no bearer) and reset the change-guard, so a later
 *      sign-in — possibly a different rider on the same device timezone — still
 *      syncs.
 *   4. Only write when the timezone actually changed since the last successful
 *      sync, so foregrounds don't churn a full-row write every time.
 *
 * Failures are swallowed: best-effort sync, the backend falls back to UTC for
 * an unknown/missing timezone, and a transient blip shouldn't surface a UI
 * error — the next foreground retries.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface TimezoneSyncDeps {
  /** Returns true when the rider is signed in. */
  isAuthenticated: () => boolean;
  /** Current IANA device timezone, e.g. "Europe/Prague". */
  currentTimezone: () => string;
  /** Persist the timezone (typically `api.updateNotificationPreferences`). */
  sync: (timezone: string) => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;
let lastSyncedTimezone: string | null = null;

/**
 * Start the foreground/startup timezone sync monitor. Returns a cleanup that's
 * safe to call multiple times.
 */
export function startTimezoneSyncMonitor(deps: TimezoneSyncDeps): () => void {
  // Drop a prior subscription (e.g. from a hot reload) so we don't accumulate
  // duplicate handlers.
  stopTimezoneSyncMonitor();

  // Cold-start sync. Fire-and-forget — the caller is a mount effect and can't
  // await us. `syncIfNeeded` no-ops for a signed-out app.
  void syncIfNeeded(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void syncIfNeeded(deps);
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  // Bind cleanup to *this specific* subscription so a stale closure (hot reload
  // / second start()) can't tear down a newer listener.
  return () => {
    if (monitorSubscription === subscription) {
      stopTimezoneSyncMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopTimezoneSyncMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
  // Reset the change-guard so the next start()'s cold-start sync always runs.
  lastSyncedTimezone = null;
}

async function syncIfNeeded(deps: TimezoneSyncDeps): Promise<void> {
  if (!deps.isAuthenticated()) {
    // Reset so a later sign-in (possibly a different rider) re-syncs even on the
    // same device timezone.
    lastSyncedTimezone = null;
    return;
  }
  const timezone = deps.currentTimezone();
  if (!timezone || timezone === lastSyncedTimezone) return;
  try {
    await deps.sync(timezone);
    // Mark synced only on success, so a failure retries on the next foreground.
    lastSyncedTimezone = timezone;
  } catch {
    // Best-effort — the backend falls back to UTC for a missing timezone, and
    // the next foreground transition tries again.
  }
}
