/**
 * Keeps the authenticated profile's regional display preferences aligned with
 * the current device. Unlike UI language and units, format locale and timezone
 * are device-derived: opening the app on another phone must not inherit the
 * browser or region settings last written by a different device.
 */

import { AppState, type AppStateStatus } from "react-native";

export interface DeviceDisplayPreferences {
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
  currentAccountPreferences: () => AccountDisplayPreferences | null;
  sync: (userId: string, patch: DisplayPreferencesPatch) => Promise<void>;
}

let monitorSubscription: { remove: () => void } | null = null;
let inFlightKey: string | null = null;

export function startDisplayPreferencesSyncMonitor(
  deps: DisplayPreferencesSyncDeps,
): () => void {
  stopDisplayPreferencesSyncMonitor();
  void syncIfNeeded(deps);

  const onChange = (next: AppStateStatus) => {
    if (next === "active") void syncIfNeeded(deps);
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  return () => {
    if (monitorSubscription === subscription) {
      stopDisplayPreferencesSyncMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopDisplayPreferencesSyncMonitor(): void {
  monitorSubscription?.remove();
  monitorSubscription = null;
  inFlightKey = null;
}

async function syncIfNeeded(deps: DisplayPreferencesSyncDeps): Promise<void> {
  if (!deps.isAuthenticated()) {
    inFlightKey = null;
    return;
  }

  const account = deps.currentAccountPreferences();
  if (!account) return;
  const device = deps.currentDevicePreferences();
  const patch: DisplayPreferencesPatch = {};
  if (device.formatLocale && device.formatLocale !== account.formatLocale) {
    patch.format_locale = device.formatLocale;
  }
  if (device.timeZone && device.timeZone !== account.timeZone) {
    patch.timezone = device.timeZone;
  }
  if (Object.keys(patch).length === 0) return;

  const key = `${account.userId}\u0000${patch.format_locale ?? ""}\u0000${patch.timezone ?? ""}`;
  if (key === inFlightKey) return;
  inFlightKey = key;
  try {
    await deps.sync(account.userId, patch);
  } catch {
    // Best-effort. The next foreground transition retries the same mismatch.
  } finally {
    if (inFlightKey === key) inFlightKey = null;
  }
}
