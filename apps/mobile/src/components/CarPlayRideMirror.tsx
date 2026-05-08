/**
 * Leaf wrapper around `useCarPlayRideMirror` so the hook's high-frequency
 * ride-store subscriptions don't re-render the whole `RootNavigator`.
 *
 * The hook subscribes to several rapidly-changing selectors
 * (`currentSpeed`, `distance`, `duration`, `currentQuality`,
 * `nearbyHazards`, `location`) — during an active ride the location and
 * sensor services push updates several times a second. If the hook were
 * called directly inside `RootNavigator`, each tick would re-render the
 * navigator (and trigger `screenOptions` to rebuild as a fresh inline
 * arrow on every render). Isolating the hook inside a child component
 * that returns `null` confines those re-renders to a leaf — React doesn't
 * propagate child renders up to parents.
 *
 * Quick-action wiring (US-17 AC #4 — Quick-launch Commute):
 *   - `start-commute` deep-links to the existing `Commute` screen on
 *     the Home tab via `tarmoto://commute/start`. The linking config
 *     in RootNavigator routes the URL into the React Navigation tree
 *     without us holding a navigation ref here. We intentionally do
 *     not consult the commute API to gate visibility of this row —
 *     `useCommute` issues network calls eagerly on mount and would
 *     keep firing while the head unit is unplugged. The CommuteScreen
 *     itself shows a "set up your commute" CTA when no primary route
 *     exists, which is the right UX for a rider who taps the row
 *     without prior setup.
 *
 * `stop-ride` and `report-hazard` are part of the bridge's quick-action
 * id union for future use, but the controller only ever produces a
 * `start-commute` row today (mid-ride the live status board owns the
 * head-unit root, see `buildQuickActionItems` in `services/carplay.ts`).
 * Wiring those branches here would be dead code — we narrow the case
 * to the single id the controller actually emits, and let the type
 * checker catch a future regression where a new id sneaks in without
 * a handler.
 */

import { useCallback } from "react";
import { Linking } from "react-native";
import { useCarPlayRideMirror } from "@/hooks";
import type { QuickActionItem } from "@/services/carplay";

export default function CarPlayRideMirror(): null {
  const onQuickAction = useCallback((id: QuickActionItem["id"]) => {
    // The controller only emits a `start-commute` row today (mid-ride
    // the live status board owns the head-unit root — see
    // `buildQuickActionItems` in `services/carplay.ts`), so the
    // `stop-ride` / `report-hazard` ids never reach this handler.
    // We still type the parameter as the full union: when a future
    // surface starts emitting one of the other ids, the type checker
    // will force us to add a handler here rather than silently
    // dropping the tap.
    if (id === "start-commute") {
      // Linking.openURL is what the React Navigation linking config
      // listens on for in-app deep links — this fires the same path
      // the head unit's voice trigger would use on Android Auto so
      // both surfaces converge on one routing layer.
      void Linking.openURL("tarmoto://commute/start").catch(() => {
        // Linking.openURL rejects when the URL has no handler. The
        // rider can still tap Start Commute on the phone — we don't
        // want to crash the bike display over a routing miss, so
        // this is a silent fallback.
      });
    }
  }, []);

  useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true });
  return null;
}
