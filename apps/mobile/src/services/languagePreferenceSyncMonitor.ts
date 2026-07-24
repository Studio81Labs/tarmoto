/**
 * Reconciles an explicit device-local UI language selection with the rider's
 * account. The local override changes the app immediately; this monitor owns
 * the best-effort PATCH and clears the pending marker only after the same
 * selection reaches the account.
 */

import { AppState, type AppStateStatus } from "react-native";
import type { SupportedLocale } from "@tarmoto/shared";

const SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

export interface LanguagePreferenceSyncDeps {
  isAuthenticated: () => boolean;
  pendingLocale: () => SupportedLocale | null;
  accountLocale: () => string | null | undefined;
  sync: (locale: SupportedLocale) => Promise<void>;
  onAlreadySynced: (locale: SupportedLocale) => void;
}

let monitorSubscription: { remove: () => void } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: { locale: SupportedLocale; token: symbol } | null = null;

export function startLanguagePreferenceSyncMonitor(
  deps: LanguagePreferenceSyncDeps,
): () => void {
  stopLanguagePreferenceSyncMonitor();
  let active = true;
  let retryIndex = 0;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const run = async (): Promise<void> => {
    const outcome = await syncIfNeeded(deps);
    if (!active) return;
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
    active = false;
    if (monitorSubscription === subscription) {
      stopLanguagePreferenceSyncMonitor();
    } else {
      subscription.remove();
      clearRetry();
    }
  };
}

export function stopLanguagePreferenceSyncMonitor(): void {
  monitorSubscription?.remove();
  monitorSubscription = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  inFlight = null;
}

async function syncIfNeeded(
  deps: LanguagePreferenceSyncDeps,
): Promise<"idle" | "synced" | "failed"> {
  if (!deps.isAuthenticated()) return "idle";
  const locale = deps.pendingLocale();
  if (!locale) return "idle";

  if (deps.accountLocale() === locale) {
    deps.onAlreadySynced(locale);
    return "synced";
  }
  if (inFlight?.locale === locale) return "idle";

  const token = Symbol("language-preference-sync");
  inFlight = { locale, token };
  try {
    await deps.sync(locale);
    return "synced";
  } catch {
    return "failed";
  } finally {
    if (inFlight?.token === token) inFlight = null;
  }
}
