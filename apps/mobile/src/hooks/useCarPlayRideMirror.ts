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
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import {
  buildQuickActionItems,
  disableCarPlayProjection,
  dismissHazardAlertOnVehicleDisplay,
  enableCarPlayProjection,
  mirrorClosestHazardAlert,
  mountQuickActions,
  mountRideStatusBoard,
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

  // Operator kill switches (off the public /config/flags fast path, fail SAFE).
  // `carplay_android_auto` is the WHOLE-projection kill: `disableCarPlayProjection`
  // swaps the head-unit root for an inert idle template and blocks every mount,
  // so no interactive surface (ride board, Start-Commute list, hazard alert)
  // survives the kill. `hazard_alerts` scopes just band 2 (the hazard mirror).
  const carplayEnabled = useFeatureKillSwitchActive("carplay_android_auto");
  const hazardAlertsEnabled = useFeatureKillSwitchActive("hazard_alerts");

  const mountedRef = useRef(false);
  const hazardActiveRef = useRef(false);

  // Whole-projection enable/disable. Declared BEFORE the band effects so, on a
  // re-enable, `enableCarPlayProjection` clears the mount block before the
  // bands (which also gate on `carplayEnabled`) re-run and re-mount. On a kill
  // it swaps the root to inert; the bands then no-op.
  useEffect(() => {
    if (carplayEnabled) enableCarPlayProjection();
    else disableCarPlayProjection();
  }, [carplayEnabled]);

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
    if (!carplayEnabled) {
      // Projection killed mid-session by the orchestration effect above (inert
      // root + mount block, which already reset the board bookkeeping). Only
      // forget our LOCAL mount so an off→on within the same ride re-mounts.
      // Must NOT call `unmountRideStatusBoard` here — that's the ride-END
      // cleanup and clears the per-ride dismissed/confirmed hazard sets, so a
      // hazard the rider already dismissed on the head unit would re-alert when
      // projection comes back.
      mountedRef.current = false;
      return;
    }
    if (!isRiding) {
      // Ride ended. The mountedRef guard avoids touching the bridge when no
      // ride was ever active (cold boot path) — `unmountRideStatusBoard` is
      // idempotent, but skipping the call also skips the native round-trip on
      // every store change while the rider is idle. This IS the ride-end
      // cleanup (it clears the per-ride hazard dedup sets), which is correct
      // here because the ride is over.
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
  }, [
    isRiding,
    carplayEnabled,
    rideType,
    speedKmh,
    distanceKm,
    durationSeconds,
    quality,
  ]);

  // ── Band 2: hazard alerts (mid-ride only) ──
  useEffect(() => {
    if (!isRiding || !carplayEnabled || !hazardAlertsEnabled) {
      if (hazardActiveRef.current) {
        dismissHazardAlertOnVehicleDisplay();
        hazardActiveRef.current = false;
      }
      return;
    }
    // The service's `mirrorClosestHazardAlert` does the dismissed-id
    // filtering, radius check, and "swap if a closer fresh hazard
    // appears" logic in one call so we can't accidentally leave a
    // stale alert mounted by branching wrong from the hook side. The
    // returned outcome lets us keep `hazardActiveRef` honest.
    const outcome = mirrorClosestHazardAlert(
      nearbyHazards,
      location ? { lat: location.lat, lng: location.lng } : null,
      HAZARD_ALERT_RADIUS_METERS,
    );
    if (outcome === "presented") hazardActiveRef.current = true;
    if (outcome === "dismissed") hazardActiveRef.current = false;
  }, [isRiding, carplayEnabled, hazardAlertsEnabled, nearbyHazards, location]);

  // ── Band 3: quick actions ──
  useEffect(() => {
    if (!carplayEnabled || !onQuickAction || quickActionItems.length === 0) {
      unmountQuickActions();
      return;
    }
    mountQuickActions(quickActionItems, onQuickAction);
  }, [carplayEnabled, quickActionItems, onQuickAction]);

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
