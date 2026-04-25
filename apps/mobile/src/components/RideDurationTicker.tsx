/**
 * Root-level ride duration ticker (US-19).
 *
 * Mirrors `Math.floor((Date.now() - startedAtMs) / 1000)` into
 * `useRideStore.duration` once per second while a ride is active,
 * regardless of which screen is mounted. Without this, `store.duration`
 * would freeze the moment the rider backed out of the live HUD — even
 * though `isRiding` is still true — and any consumer reading the store
 * (`useCarPlayRideMirror`, the in-progress banner on `RideScreen`) would
 * lose seconds spent off-HUD. Re-deriving from the wall-clock anchor
 * also makes the count self-correct after a phone freeze, an OS
 * suspension, or the rider scrubbing through tabs: even if a tick is
 * missed, the next tick lands at the right total.
 *
 * Mounted as a leaf in `RootNavigator` next to `CarPlayRideMirror` so
 * its high-frequency store writes don't re-render the navigator tree.
 */
import { useEffect } from "react";
import { useRideStore } from "@/stores";

export default function RideDurationTicker(): null {
  const isRiding = useRideStore((s) => s.isRiding);
  const startedAtMs = useRideStore((s) => s.startedAtMs);
  const updateDuration = useRideStore((s) => s.updateDuration);

  useEffect(() => {
    if (!isRiding || startedAtMs === null) return;

    const tick = () => {
      const seconds = Math.max(
        0,
        Math.floor((Date.now() - startedAtMs) / 1000),
      );
      updateDuration(seconds);
    };
    // Fire once immediately so the HUD doesn't display 0 for the first
    // full second after a fresh start.
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRiding, startedAtMs, updateDuration]);

  return null;
}
