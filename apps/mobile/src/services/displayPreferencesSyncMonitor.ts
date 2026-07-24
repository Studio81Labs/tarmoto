/**
 * Publishes the current device's UI/format locale and timezone to the live app
 * providers, and keeps the authenticated profile's regional preferences
 * aligned. UI locale is only a signed-out/default input; explicit local or
 * account language choices retain precedence in App.tsx.
 */

import { AppState, type AppStateStatus } from "react-native";

const SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

export interface DeviceDisplayPreferences {
  uiLocale: string | null;
  formatLocale: string | null;
  timeZone: string | null;
}

export interface AccountDisplayPreferences {
  userId: string;
  formatLocale?: string | null;
  timeZone?: string | null;
}

export interface DisplayPreferencesPatch {
  format_locale?: string;
  timezone?: string;
}

export interface DisplayPreferencesSyncDeps {
  isAuthenticated: () => boolean;
  currentDevicePreferences: () => DeviceDisplayPreferences;
  onDevicePreferencesDetected?: (preferences: DeviceDisplayPreferences) => void;
  currentAccountPreferences: () => AccountDisplayPreferences | null;
  sync: (userId: string, patch: DisplayPreferencesPatch) => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let activeMonitorToken: symbol | null = null;
let inFlight: { key: string; promise: Promise<void> } | null = null;

export function startDisplayPreferencesSyncMonitor(
  deps: DisplayPreferencesSyncDeps,
): () => void {
  stopDisplayPreferencesSyncMonitor();
  const monitorToken = Symbol("display-preferences-monitor");
  activeMonitorToken = monitorToken;
  let retryIndex = 0;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const run = async (): Promise<void> => {
    if (activeMonitorToken !== monitorToken) return;
    if (retryTimer) {
      // Foreground detection must remain live while the account PATCH backs
      // off, but foreground events must not bypass that delay with another
      // write. The timer callback clears retryTimer before calling run().
      deps.onDevicePreferencesDetected?.(deps.currentDevicePreferences());
      return;
    }
    const outcome = await syncIfNeeded(
      deps,
      () => activeMonitorToken === monitorToken,
    );
    if (activeMonitorToken !== monitorToken) return;
    if (outcome !== "failed") {
      retryIndex = 0;
      clearRetry();
      return;
    }
    if (retryTimer) return;
    const delay =
      SYNC_RETRY_DELAYS_MS[
        Math.min(retryIndex, SYNC_RETRY_DELAYS_MS.length - 1)
      ];
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run();
    }, delay);
  };

  void run();

  const onChange = (next: AppStateStatus) => {
    if (next === "active") void run();
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  return () => {
    if (activeMonitorToken === monitorToken) {
      stopDisplayPreferencesSyncMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopDisplayPreferencesSyncMonitor(): void {
  activeMonitorToken = null;
  monitorSubscription?.remove();
  monitorSubscription = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  // Keep an active PATCH as the serialization mutex across monitor restarts.
  // App profile updates restart this monitor, and clearing it here would let
  // the replacement send the same or a newer device snapshot concurrently.
}

async function syncIfNeeded(
  deps: DisplayPreferencesSyncDeps,
  isActive: () => boolean,
): Promise<"idle" | "synced" | "failed"> {
  // Detection also drives the live provider state. Do it before the auth gate
  // so signed-out riders and failed backend syncs still pick up a region or
  // timezone change immediately on foreground.
  let device = deps.currentDevicePreferences();
  deps.onDevicePreferencesDetected?.(device);

  if (!isActive() || !deps.isAuthenticated()) return "idle";

  // Serialize foreground events and monitor restarts behind the active PATCH.
  // Once it settles, re-read both the device and account before deciding what
  // remains to be written.
  let waitedForKey: string | null = null;
  while (inFlight) {
    waitedForKey = inFlight.key;
    const activePromise = inFlight.promise;
    try {
      await activePromise;
    } catch {
      // Do not let a concurrent foreground waiter bypass the backoff owned by
      // run(). A replacement monitor also schedules its own retry here because
      // the stopped request owner is no longer allowed to install a timer.
      return isActive() ? "failed" : "idle";
    }
    if (!isActive()) return "idle";
  }

  device = deps.currentDevicePreferences();
  deps.onDevicePreferencesDetected?.(device);
  const account = deps.currentAccountPreferences();
  if (!account) return "idle";
  const patch: DisplayPreferencesPatch = {};
  if (device.formatLocale && device.formatLocale !== account.formatLocale) {
    patch.format_locale = device.formatLocale;
  }
  if (device.timeZone && device.timeZone !== account.timeZone) {
    patch.timezone = device.timeZone;
  }
  if (Object.keys(patch).length === 0) return "idle";

  const key = `${account.userId}\u0000${patch.format_locale ?? ""}\u0000${patch.timezone ?? ""}`;
  // A concurrent foreground callback that waited for this exact successful
  // write must not immediately duplicate it merely because its account
  // snapshot has not re-rendered yet. A later independent run may reconcile
  // again if the live account really remains stale.
  if (key === waitedForKey) return "synced";
  const promise = deps.sync(account.userId, patch);
  inFlight = { key, promise };
  try {
    await promise;
    return "synced";
  } catch {
    return "failed";
  } finally {
    if (inFlight?.key === key && inFlight.promise === promise) inFlight = null;
  }
}
