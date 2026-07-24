/**
 * Reconciles an explicit device-local UI language selection with the rider's
 * account. The local override changes the app immediately; this monitor owns
 * the best-effort PATCH and clears the pending marker only after the same
 * selection reaches the account.
 */

import { AppState, type AppStateStatus } from "react-native";
import type { SupportedLocale } from "@tarmoto/shared";

const SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

export interface PendingLanguageSelection {
  locale: SupportedLocale;
  ownerUserId: string | null;
}

export interface LanguagePreferenceSyncDeps {
  isAuthenticated: () => boolean;
  currentUserId: () => string | null;
  pendingSelection: () => PendingLanguageSelection | null;
  accountLocale: () => string | null | undefined;
  sync: (selection: PendingLanguageSelection) => Promise<void>;
  onAlreadySynced: (selection: PendingLanguageSelection) => void;
  onOwnerMismatch: (selection: PendingLanguageSelection) => void;
}

let monitorSubscription: { remove: () => void } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let activeMonitorToken: symbol | null = null;
let inFlight: {
  selection: PendingLanguageSelection;
  promise: Promise<void>;
} | null = null;

export function startLanguagePreferenceSyncMonitor(
  deps: LanguagePreferenceSyncDeps,
): () => void {
  stopLanguagePreferenceSyncMonitor();
  const monitorToken = Symbol("language-preference-monitor");
  activeMonitorToken = monitorToken;
  let retryIndex = 0;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const run = async (): Promise<void> => {
    if (activeMonitorToken !== monitorToken) return;
    const outcome = await syncIfNeeded(
      deps,
      () => activeMonitorToken === monitorToken,
    );
    if (activeMonitorToken !== monitorToken) return;
    if (outcome === "superseded") {
      retryIndex = 0;
      clearRetry();
      // The rider may have selected another locale while this serialized write
      // was in flight. Re-read the live marker immediately instead of waiting
      // for another foreground transition.
      void run();
      return;
    }
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
      stopLanguagePreferenceSyncMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopLanguagePreferenceSyncMonitor(): void {
  activeMonitorToken = null;
  monitorSubscription?.remove();
  monitorSubscription = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  // Do not clear an active write: a replacement monitor must wait for it
  // before sending the newest selection, otherwise two PATCHes can race.
}

async function syncIfNeeded(
  deps: LanguagePreferenceSyncDeps,
  isActive: () => boolean,
): Promise<"idle" | "synced" | "superseded" | "failed"> {
  if (!isActive() || !deps.isAuthenticated()) return "idle";

  // Serialize every language PATCH, including across monitor restarts caused
  // by a rapid local selection. The waiter re-reads pendingSelection below
  // after the previous request settles, guaranteeing server arrival order.
  while (inFlight) {
    const activePromise = inFlight.promise;
    try {
      await activePromise;
    } catch {
      // The request owner schedules its own retry. This waiter still needs to
      // re-read the live selection, which may already supersede that failure.
    }
    // Another waiter may have acquired the mutex when the same promise
    // settled. Loop so this caller waits for that replacement too.
    if (!isActive()) return "idle";
  }

  const currentUserId = deps.currentUserId();
  const selection = deps.pendingSelection();
  if (!currentUserId || !selection) return "idle";

  if (
    selection.ownerUserId !== null &&
    selection.ownerUserId !== currentUserId
  ) {
    deps.onOwnerMismatch(selection);
    return "synced";
  }

  if (deps.accountLocale() === selection.locale) {
    deps.onAlreadySynced(selection);
    return "synced";
  }
  const promise = deps.sync(selection);
  inFlight = { selection, promise };
  try {
    await promise;
    const latest = deps.pendingSelection();
    return latest && !sameSelection(latest, selection)
      ? "superseded"
      : "synced";
  } catch {
    return "failed";
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

function sameSelection(
  left: PendingLanguageSelection,
  right: PendingLanguageSelection,
): boolean {
  return left.locale === right.locale && left.ownerUserId === right.ownerUserId;
}
