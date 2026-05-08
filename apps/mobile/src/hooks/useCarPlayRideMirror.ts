/**
 * useCarPlayRideMirror — US-17 AC #6 "Single bridge that translates ride
 * state from Zustand stores into a platform-agnostic shape consumed by
 * both iOS and Android native modules".
 *
 * Mounted once at the root of the app via the `CarPlayRideMirror` leaf
 * component. Subscribes to the slices of the ride and hazard stores
 * that drive head-unit surfaces, and dispatches them through the
 * platform-agnostic functions in `services/carplay.ts`. The service
 * layer picks the right native template (CarPlay on iOS, Android Auto
 * on Android, no-op everywhere else) so this hook is platform-agnostic
 * by construction.
 *
 * Lifecycle bands the hook drives:
 *
 *   1. Ride status board (always-on while riding) — mirror speed,
 *      distance, duration, and surface classification onto the head
 *      unit's information / pane template (`mountRideStatusBoard` /
 *      `unmountRideStatusBoard`).
 *
 *   2. Hazard alerts (mid-ride only) — when the closest known hazard
 *      enters proximity, present a CPAlertTemplate / AlertTemplate so
 *      the rider can confirm or dismiss it from the bike display
 *      (`presentHazardAlertOnVehicleDisplay` /
 *      `dismissHazardAlertOnVehicleDisplay`).
 *
 *   3. Quick actions (pre-ride and mid-ride) — show a ListTemplate
 *      with one-tap reach for Start Commute (US-21) pre-ride, or
 *      Stop ride / Report hazard mid-ride
 *      (`mountQuickActions` / `unmountQuickActions`).
 *
 * No-op everywhere CarPlay/AA isn't reachable (web, missing native
 * binding, Jest) — the underlying `services/carplay.ts` resolves to a
 * no-op bridge in those environments, so the hook can be installed
 * unconditionally without guarding the platform at the call site.
 */

import { useEffect, useMemo, useRef } from "react";
import { useHazardStore, useRideStore } from "@/stores";
import {
  buildHazardAlertSnapshot,
  buildQuickActionItems,
  dismissHazardAlertOnVehicleDisplay,
  mountQuickActions,
  mountRideStatusBoard,
  presentHazardAlertOnVehicleDisplay,
  selectClosestHazard,
  unmountQuickActions,
  unmountRideStatusBoard,
  type RideStatusBoard,
} from "@/services/carplay";

/**
 * Distance band inside which a route hazard becomes alert-worthy on
 * the head unit. 750 m is the same threshold the on-screen `Hazard`
 * notifications use today (`commuteHazardNotifier`); keeping the two
 * surfaces in lockstep means a rider scanning the bike display and a
 * passenger tapping the phone get the same picture of "what's close".
 */
const HAZARD_ALERT_RADIUS_METERS = 750;

export interface UseCarPlayRideMirrorOptions {
  /**
   * Stable callback invoked when the rider taps a quick-action row on
   * the head unit. Routed back into the host app via the deep-link /
   * ride-store side from the calling component (e.g. `RootNavigator`
   * dispatches `tarmoto://commute/start` for `start-commute`).
   *
   * Optional so tests and pre-MVP setups can install the hook without
   * wiring the side effects yet — the bridge will still mount the
   * ride board and hazard alerts.
   */
  onQuickAction?: (id: "start-commute" | "stop-ride" | "report-hazard") => void;
  /**
   * Whether the rider has a saved commute route eligible for one-tap
   * Start Commute. Pre-ride only — when true, the quick-actions list
   * adds the Start Commute row.
   */
  hasCommuteRoute?: boolean;
}

export function useCarPlayRideMirror(
  options: UseCarPlayRideMirrorOptions = {},
): void {
  const isRiding = useRideStore((s) => s.isRiding);
  const rideType = useRideStore((s) => s.rideType);
  const speedKmh = useRideStore((s) => s.currentSpeed);
  const distanceKm = useRideStore((s) => s.distance);
  const durationSeconds = useRideStore((s) => s.duration);
  const quality = useRideStore((s) => s.currentQuality);
  const location = useRideStore((s) => s.location);
  const nearbyHazards = useHazardStore((s) => s.nearbyHazards);

  const mountedRef = useRef(false);
  const hazardActiveRef = useRef(false);

  // Memoise the quick-actions input so a high-frequency ride-tick
  // (speed / distance) doesn't spam `mountQuickActions` — the items
  // only change on `isRiding` / `hasCommuteRoute`.
  const quickActionItems = useMemo(
    () =>
      buildQuickActionItems({
        isRiding,
        hasCommuteRoute: options.hasCommuteRoute ?? false,
      }),
    [isRiding, options.hasCommuteRoute],
  );
  const onQuickAction = options.onQuickAction;

  // ── Band 1: ride status board ──
  useEffect(() => {
    if (!isRiding) {
      // The mountedRef guard avoids touching the bridge when no ride was
      // ever active (cold boot path) — `unmountRideStatusBoard` itself
      // is idempotent, but skipping the call also skips the native
      // round-trip on every store change while the rider is idle.
      if (mountedRef.current) {
        unmountRideStatusBoard();
        mountedRef.current = false;
      }
      return;
    }

    const board: RideStatusBoard = {
      speedKmh,
      distanceKm,
      durationSeconds,
      qualityScore: quality?.quality_score ?? null,
      // The on-device classifier in `services/sensors.ts` reports
      // confidence as a 0-100 integer percent (currently 30 / 70 based
      // on speed). The CarPlay formatter contract is a 0-1 fraction —
      // matching the backend's `RoadSegmentDetail.confidence` shape —
      // so we convert at this boundary rather than reshape every
      // formatter caller.
      qualityConfidence:
        quality?.confidence != null ? quality.confidence / 100 : null,
      rideType,
    };

    const accepted = mountRideStatusBoard(board);
    if (accepted) mountedRef.current = true;
  }, [isRiding, rideType, speedKmh, distanceKm, durationSeconds, quality]);

  // ── Band 2: hazard alerts (mid-ride only) ──
  useEffect(() => {
    if (!isRiding) {
      if (hazardActiveRef.current) {
        dismissHazardAlertOnVehicleDisplay();
        hazardActiveRef.current = false;
      }
      return;
    }
    const closest = selectClosestHazard(
      nearbyHazards,
      location ? { lat: location.lat, lng: location.lng } : null,
    );
    if (!closest || closest.distanceMeters > HAZARD_ALERT_RADIUS_METERS) {
      // Nothing close — fold any standing alert. The dismissedHazardIds
      // set inside the service prevents re-presenting a previously
      // dismissed hazard if it stays in the nearby list.
      if (hazardActiveRef.current) {
        dismissHazardAlertOnVehicleDisplay();
        hazardActiveRef.current = false;
      }
      return;
    }
    const snapshot = buildHazardAlertSnapshot(
      closest.hazard,
      closest.distanceMeters,
    );
    const accepted = presentHazardAlertOnVehicleDisplay(snapshot);
    if (accepted) hazardActiveRef.current = true;
  }, [isRiding, nearbyHazards, location]);

  // ── Band 3: quick actions ──
  useEffect(() => {
    if (!onQuickAction || quickActionItems.length === 0) {
      unmountQuickActions();
      return;
    }
    mountQuickActions(quickActionItems, onQuickAction);
  }, [quickActionItems, onQuickAction]);

  // Belt-and-braces cleanup if the host (RootNavigator) ever unmounts —
  // not expected during a session, but a hot reload during dev shouldn't
  // leave the CarPlay templates orphaned on the bike display.
  useEffect(() => {
    return () => {
      if (mountedRef.current) {
        unmountRideStatusBoard();
        mountedRef.current = false;
      }
      if (hazardActiveRef.current) {
        dismissHazardAlertOnVehicleDisplay();
        hazardActiveRef.current = false;
      }
      unmountQuickActions();
    };
  }, []);
}
