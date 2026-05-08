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
 *   - `stop-ride` calls the ride store's `stopRide` directly so the
 *     rider can end a ride from the bike display in one tap.
 *   - `report-hazard` deep-links to the hazard report modal with the
 *     map tab as the host (same path the Google Assistant App Action
 *     uses today on Android Auto, see `res/xml/shortcuts.xml`).
 */

import { useCallback } from "react";
import { Linking } from "react-native";
import { useCarPlayRideMirror } from "@/hooks";
import { useRideStore } from "@/stores";

export default function CarPlayRideMirror(): null {
  const stopRide = useRideStore((s) => s.stopRide);

  const onQuickAction = useCallback(
    (id: "start-commute" | "stop-ride" | "report-hazard") => {
      switch (id) {
        case "start-commute":
          // Linking.openURL is what the React Navigation linking config
          // listens on for in-app deep links — this fires the same
          // path the head unit's voice trigger would use on Android
          // Auto so both surfaces converge on one routing layer.
          void Linking.openURL("tarmoto://commute/start").catch(() => {
            // Linking.openURL rejects when the URL has no handler. The
            // rider can still tap Start Commute on the phone — we
            // don't want to crash the bike display over a routing
            // miss, so this is a silent fallback.
          });
          return;
        case "stop-ride":
          stopRide();
          return;
        case "report-hazard":
          void Linking.openURL("tarmoto://hazard/report").catch(() => {
            // Same defensive swallow — the in-app FAB is still usable
            // from the phone if the deep link doesn't resolve.
          });
          return;
      }
    },
    [stopRide],
  );

  useCarPlayRideMirror({ onQuickAction, hasCommuteRoute: true });
  return null;
}
