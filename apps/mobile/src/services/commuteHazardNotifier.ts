/**
 * Commute hazard notifier — US-15 AC #2.
 *
 * Fires an alert the first time the rider opens the app and their primary
 * commute has hazards they haven't seen on CommuteScreen yet. The in-app
 * diff UI (`useCommute` + `useCommuteStore.seenHazardsByRoute`) already
 * knows which hazards are NEW — this layer turns that knowledge into a
 * pre-ride warning so a rider doesn't have to navigate to the Commute tab
 * to discover a pothole popped up on last night's route.
 *
 * Non-goals for this slice:
 *   - OS-level push delivered while the app is killed. That requires a
 *     native notification module (`@notifee/react-native` or similar) plus
 *     pod/Gradle setup. The `Notifier` interface below is the seam where
 *     that module will plug in; call sites and dedup/diff logic won't
 *     change.
 *   - Server-pushed alerts via FCM/APNS. Same seam — the backend event
 *     fan-out is a follow-up workstream per the CommuteScreen comment.
 *
 * Design mirrors `services/carplay.ts`:
 *   - A guarded lazy require for the native haptic module so jest and
 *     platforms without the binding still import cleanly.
 *   - An injected bridge (here: `Notifier`) with a test setter so unit
 *     tests assert the decision logic without touching RN Alert.
 *   - A pure `decideCommuteHazardNotification` function so the branch
 *     that turns "commute status + seen set" into a notification is
 *     trivially testable and deterministic.
 */

import { Alert, AppState, type AppStateStatus } from "react-native";
import type { Hazard } from "@/types";
import { api } from "@/services/api";
import { diffNewHazards, useAuthStore, useCommuteStore } from "@/stores";
import { t as translate } from "@/i18n";
import { isFeatureEnabled } from "@tarmoto/shared";
import { isFeatureKillSwitchActive } from "./systemSwitchCache";

// ── Public types ──

export interface NotificationPayload {
  title: string;
  body: string;
  /**
   * Stable identifier for this notification's content. Callers use it to
   * dedup identical notifications within a session (same hazards, same
   * route) — we never want to buzz the rider twice for the same set of
   * hazards they haven't acknowledged yet.
   */
  tag: string;
  /** IDs of the hazards this notification surfaces, in input order. */
  hazardIds: string[];
}

export interface Notifier {
  /** Whether this environment can surface a notification (e.g. not in SSR). */
  isAvailable(): boolean;
  notify(payload: NotificationPayload): void;
}

// ── Notifier implementation ──

/**
 * Minimal haptic adapter — guarded require so we don't crash in jest or
 * on platforms without the native binding. The notification still fires
 * visually; haptics are a best-effort nudge.
 */
interface HapticTrigger {
  trigger: () => void;
}

function loadHaptics(): HapticTrigger {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-haptic-feedback") as {
      default?: { trigger?: (type: string) => void };
      trigger?: (type: string) => void;
    };
    const trigger = mod.default?.trigger ?? mod.trigger;
    if (typeof trigger !== "function") {
      return { trigger: () => {} };
    }
    // "notificationWarning" is the cross-platform name for a two-pulse
    // alert haptic — same pattern Apple uses for incoming alert banners.
    return { trigger: () => trigger("notificationWarning") };
  } catch {
    return { trigger: () => {} };
  }
}

function createAlertNotifier(): Notifier {
  const haptics = loadHaptics();
  return {
    isAvailable: () => true,
    notify: ({ title, body }) => {
      haptics.trigger();
      // Alert.alert is always available in React Native; on a headless
      // environment (jest) it's a jest.fn by default and simply records
      // the call. On device it pops a modal with an OK button — enough
      // to stop the rider before they head out. Swapping to a real OS
      // notification (local or push) is a drop-in replacement of this
      // `notify` impl via `__setNotifierForTest` in prod wiring.
      Alert.alert(title, body);
    },
  };
}

let notifier: Notifier | null = null;

function getNotifier(): Notifier {
  if (!notifier) notifier = createAlertNotifier();
  return notifier;
}

/** Test seam — inject a fake notifier. Pass `null` to reset to default. */
export function __setNotifierForTest(next: Notifier | null): void {
  notifier = next;
  sessionNotifiedByRoute.clear();
  checkInProgress = false;
  monitorSubscription?.remove();
  monitorSubscription = null;
}

// ── Session-level dedup ──
// A rider who opens the app, dismisses the Alert without navigating to the
// Commute tab, and re-opens the app 2 minutes later shouldn't see the exact
// same banner again. `seenHazardsByRoute` is about the NEW badges on
// CommuteScreen — it only advances when the rider explicitly taps "Mark all
// seen", which is a different affordance than dismissing an Alert dialog.
//
// Keep the "already notified this session" set independent so:
//   - Opening the Alert doesn't advance the badge state (badges stay until
//     the rider actually views the list).
//   - Closing the Alert doesn't re-fire it on the next foreground event.
//   - A relaunch of the app (which clears this Map) will re-alert about
//     anything still unacknowledged, which is correct: a new app session
//     is a new "before ride" opportunity.
const sessionNotifiedByRoute = new Map<string, Set<string>>();

function getSessionNotified(routeId: string): Set<string> {
  let s = sessionNotifiedByRoute.get(routeId);
  if (!s) {
    s = new Set();
    sessionNotifiedByRoute.set(routeId, s);
  }
  return s;
}

// ── Pure decision logic ──

export interface DecideInput {
  routeId: string;
  routeName: string;
  hazards: Hazard[];
  /** IDs the rider has already acknowledged on CommuteScreen. */
  lastSeen: Set<string>;
  /** IDs we already notified about this session — do not re-notify. */
  alreadyNotified: Set<string>;
}

/**
 * Returns a notification payload if there are unseen and un-notified
 * hazards on the route, else null.
 *
 * Pure — no RN / network. Callers commit the returned `hazardIds` to
 * `alreadyNotified` only after a successful `notify()`.
 */
export function decideCommuteHazardNotification(
  input: DecideInput,
): NotificationPayload | null {
  const { routeName, hazards, lastSeen, alreadyNotified } = input;
  const currentIds = hazards.map((h) => h.id);
  const newIds = diffNewHazards(currentIds, lastSeen).filter(
    (id) => !alreadyNotified.has(id),
  );
  if (newIds.length === 0) return null;

  const count = newIds.length;
  // Prefer the primary hazard's road name in the body so the rider knows
  // *where* before they even open the app — falling back to the route
  // name when the hazard has no road_name attached (older reports).
  const first = hazards.find((h) => newIds.includes(h.id));
  const where = first?.road_name?.trim() || routeName;
  return {
    title: translate(
      "{count, plural, one {# new hazard} other {# new hazards}} on your commute",
      { count },
    ),
    body: translate(
      "{count, plural, one {Check {where} before you head out.} other {Check {where} and {otherCount, plural, one {# other spot} other {# other spots}} before you head out.}}",
      { count, otherCount: count - 1, where },
    ),
    tag: `commute:${input.routeId}:${[...newIds].sort().join(",")}`,
    hazardIds: newIds,
  };
}

// ── Network + side effects ──

export interface CheckResult {
  /** Whether a notification fired. */
  notified: boolean;
  /** Hazard IDs that fired (empty if `notified` is false). */
  hazardIds: string[];
  /** Reason for a no-op, for diagnostics. */
  reason?:
    | "no-primary-commute"
    | "no-hazards"
    | "all-seen"
    | "all-notified"
    | "notifier-unavailable"
    | "api-error"
    | "check-in-progress"
    | "commute-not-entitled"
    | "hazard-alerts-disabled";
}

// Guards against a second check being started while the first is still
// in flight (e.g. rapid background→active→background→active bounces on
// iOS). The existing dedup via `alreadyNotified` already makes duplicate
// *alerts* impossible — JS is single-threaded and there's no await
// between the dedup read and the `alreadyNotified.add` write — but the
// guard still avoids stacking two concurrent API round trips for no
// gain.
let checkInProgress = false;

/**
 * Fetch the rider's primary commute + status, compute a notification, and
 * fire it if warranted. Safe to call on every app-foreground transition —
 * dedup and acknowledge-awareness are handled inside.
 */
export async function checkCommuteHazardsAndNotify(): Promise<CheckResult> {
  const impl = getNotifier();
  if (!impl.isAvailable()) {
    return { notified: false, hazardIds: [], reason: "notifier-unavailable" };
  }
  if (checkInProgress) {
    return { notified: false, hazardIds: [], reason: "check-in-progress" };
  }

  // commuter_mode is a Pro entitlement. This service runs on cold start and
  // every app-foreground transition, OUTSIDE React, so it can't use the
  // useFeature hook — read the resolved snapshot straight off the auth store.
  // A non-entitled (or unresolved — features slice absent) rider must NOT hit
  // the guarded /commute/* endpoints only to swallow a 403. `isFeatureEnabled`
  // fails closed on a missing key/slice.
  const features = useAuthStore.getState().user?.features ?? null;
  if (!features || !isFeatureEnabled(features, "commuter_mode")) {
    return { notified: false, hazardIds: [], reason: "commute-not-entitled" };
  }

  // `hazard_alerts` operator kill switch — the same free-tier switch that stops
  // community hazard reception on the map also silences this app-level pre-ride
  // commute hazard alert during an alert-spam / false-positive storm. Read off
  // the /config/flags cache (fail SAFE, on unless force_off).
  if (!isFeatureKillSwitchActive("hazard_alerts")) {
    return { notified: false, hazardIds: [], reason: "hazard-alerts-disabled" };
  }

  checkInProgress = true;

  try {
    const routes = await api.getCommuteRoutes();
    const primary = routes.find((r) => r.is_primary) ?? routes[0] ?? null;
    if (!primary) {
      return { notified: false, hazardIds: [], reason: "no-primary-commute" };
    }

    const status = await api.getCommuteStatus();
    if (status.hazards.length === 0) {
      return { notified: false, hazardIds: [], reason: "no-hazards" };
    }

    const lastSeen = useCommuteStore.getState().getSeenHazards(primary.id);
    const alreadyNotified = getSessionNotified(primary.id);

    const payload = decideCommuteHazardNotification({
      routeId: primary.id,
      routeName: primary.name,
      hazards: status.hazards,
      lastSeen,
      alreadyNotified,
    });

    if (!payload) {
      // Pick the reason by *actual* filter that removed the batch, not by
      // whether `alreadyNotified` happens to hold IDs from an earlier
      // check. A rider who was alerted about hazard A, then visited
      // CommuteScreen and acknowledged B/C, then reopens the app with a
      // status of [B, C] must see "all-seen" — even though
      // `alreadyNotified` still holds A from the first alert.
      const allSeen = status.hazards.every((h) => lastSeen.has(h.id));
      return {
        notified: false,
        hazardIds: [],
        reason: allSeen ? "all-seen" : "all-notified",
      };
    }

    // Re-check the entitlement RIGHT BEFORE delivering: commuter_mode may have
    // been revoked while the /commute/* requests were in flight (the status
    // response can resolve after the refreshed profile disabled the feature).
    // Deliver a paid hazard alert only if the rider still has access.
    if (!commuterModeGranted({ user: useAuthStore.getState().user })) {
      return { notified: false, hazardIds: [], reason: "commute-not-entitled" };
    }
    // Same for the `hazard_alerts` kill switch: this monitor is started before
    // the system-switch refresh monitor, so both begin from the previously
    // cached state; a `force_off` can land while the /commute/* requests are in
    // flight. Re-read the cache immediately before delivery so an alert-spam
    // kill can't still emit the notification it was meant to silence.
    if (!isFeatureKillSwitchActive("hazard_alerts")) {
      return {
        notified: false,
        hazardIds: [],
        reason: "hazard-alerts-disabled",
      };
    }
    impl.notify(payload);
    for (const id of payload.hazardIds) alreadyNotified.add(id);
    return { notified: true, hazardIds: payload.hazardIds };
  } catch {
    // Network blip, unauth, offline — stay silent. The rider will still
    // see the NEW badges on CommuteScreen when connectivity returns; a
    // noisy "couldn't check" error dialog on every cold start would be
    // worse than a silent miss.
    return { notified: false, hazardIds: [], reason: "api-error" };
  } finally {
    checkInProgress = false;
  }
}

// ── AppState monitor ──

let monitorSubscription: { remove: () => void } | null = null;
// Unsubscribe for the auth-store watcher that retries the check once the
// commuter_mode entitlement resolves — see startCommuteHazardMonitor.
let monitorAuthUnsub: (() => void) | null = null;

/**
 * Whether the given auth-store state currently grants commuter_mode. Fails
 * closed on an absent features slice (legacy/optimistic cached profile).
 */
function commuterModeGranted(state: {
  user?: { features?: unknown } | null;
}): boolean {
  const features = state.user?.features ?? null;
  return (
    features != null &&
    isFeatureEnabled(
      features as Parameters<typeof isFeatureEnabled>[0],
      "commuter_mode",
    )
  );
}

/**
 * Subscribe to app foreground events and run a commute hazard check each
 * time. Returns an unsubscribe that's safe to call multiple times.
 *
 * The first check fires immediately on `start()` regardless of the
 * current AppState — React Native reports `currentState: 'active'` when
 * the JS bundle evaluates on cold start, but no 'change' event ever
 * fires for that initial transition so relying on the listener alone
 * would miss the most important "before ride" moment.
 */
export function startCommuteHazardMonitor(): () => void {
  // Prior subscription (e.g. from a hot reload) — drop it before wiring
  // a new one so we don't accumulate duplicate handlers.
  stopCommuteHazardMonitor();

  // Immediate check on start. Fire-and-forget: the caller is a mount
  // effect and can't await us anyway.
  void checkCommuteHazardsAndNotify();

  const onChange = (next: AppStateStatus) => {
    if (next === "active") {
      void checkCommuteHazardsAndNotify();
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  // Cold start is often optimistic: App.tsx starts this monitor as soon as a
  // cached profile clears `isLoading`, which may lack `features` or hold a
  // stale `commuter_mode: false`. The immediate check above then fails closed.
  // Watch the auth store and re-run the check the moment commuter_mode
  // transitions to granted (the refreshed snapshot lands) so an entitled rider
  // still gets the promised cold-start alert without waiting for a later
  // background→active transition. AppState doesn't fire for that entitlement
  // change, so this subscription is the only trigger.
  monitorAuthUnsub = useAuthStore.subscribe((state, prev) => {
    if (commuterModeGranted(state) && !commuterModeGranted(prev)) {
      void checkCommuteHazardsAndNotify();
    }
  });

  // Bind the returned cleanup to *this specific* subscription so a stale
  // cleanup closure (e.g. from an unmounted root after a hot reload or a
  // second start() call) can't accidentally tear down a newer listener
  // and leave the app with no hazard monitor. `stopCommuteHazardMonitor`
  // remains the global "drop whatever's active" helper for tests and
  // top-level resets.
  return () => {
    if (monitorSubscription === subscription) {
      subscription.remove();
      monitorSubscription = null;
      monitorAuthUnsub?.();
      monitorAuthUnsub = null;
    }
  };
}

function stopCommuteHazardMonitor(): void {
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
  monitorAuthUnsub?.();
  monitorAuthUnsub = null;
}

/** Test reset — drop any active subscription and clear session dedup. */
export function __resetCommuteHazardNotifierForTest(): void {
  stopCommuteHazardMonitor();
  sessionNotifiedByRoute.clear();
  checkInProgress = false;
  notifier = null;
}
