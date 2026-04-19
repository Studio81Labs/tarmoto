/**
 * useCarPlayRideMirror — US-17 AC #3 "Basic ride stats visible".
 *
 * Bridges `useRideStore` to the CarPlay information template. Mounted
 * once at the root of the app so the bike display reflects the current
 * ride no matter which tab the rider has open on the phone.
 *
 * Lifecycle:
 *   - When `isRiding` flips true, mount the CarPlay template seeded with
 *     the current snapshot.
 *   - While `isRiding` stays true, push every tick (speed / distance /
 *     duration / surface classification) into the template.
 *   - When `isRiding` flips false (rider stops, or app boots without an
 *     active ride), tear the template down so the CarPlay display goes
 *     back to its idle root.
 *
 * No-op everywhere CarPlay isn't reachable (Android, missing native
 * binding, Jest) — the underlying `services/carplay.ts` resolves to a
 * no-op bridge in those environments, so the hook can be installed
 * unconditionally without guarding the platform at the call site.
 */

import { useEffect, useRef } from "react";
import { useRideStore } from "@/stores";
import {
  mountRideStatusBoard,
  unmountRideStatusBoard,
  type RideStatusBoard,
} from "@/services/carplay";

export function useCarPlayRideMirror(): void {
  const isRiding = useRideStore((s) => s.isRiding);
  const rideType = useRideStore((s) => s.rideType);
  const speedKmh = useRideStore((s) => s.currentSpeed);
  const distanceKm = useRideStore((s) => s.distance);
  const durationSeconds = useRideStore((s) => s.duration);
  const quality = useRideStore((s) => s.currentQuality);

  const mountedRef = useRef(false);

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

    // `mountRideStatusBoard` also handles the ride-type title-change
    // path (it re-issues setRootTemplate when the title differs from
    // what's currently mounted), so calling it unconditionally while
    // riding is correct. The service decides mount-vs-update internally
    // based on the board title vs. its own mounted state. `mountedRef`
    // tracks whether the bridge accepted the mount so the cleanup
    // effect below can skip the unmount call when CarPlay was never
    // connected (no native round-trip needed).
    const accepted = mountRideStatusBoard(board);
    if (accepted) mountedRef.current = true;
  }, [isRiding, rideType, speedKmh, distanceKm, durationSeconds, quality]);

  // Belt-and-braces cleanup if the host (RootNavigator) ever unmounts —
  // not expected during a session, but a hot reload during dev shouldn't
  // leave the CarPlay template orphaned on the bike display.
  useEffect(() => {
    return () => {
      if (mountedRef.current) {
        unmountRideStatusBoard();
        mountedRef.current = false;
      }
    };
  }, []);
}
