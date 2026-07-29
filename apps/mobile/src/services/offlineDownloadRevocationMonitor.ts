/**
 * App-level guard that cancels in-flight offline-region downloads the instant
 * offline access is revoked — regardless of which screen is mounted.
 *
 * `OfflineRegionsScreen` already cancels on a resolved-locked render, but that
 * only fires while the rider is ON that screen. The realistic revocation path
 * is: start a large download, tap Back to the map, then a foreground
 * entitlement refresh (the `entitlementsRefreshMonitor`) downgrades the rider
 * while they're elsewhere. The download registry is module-level and survives
 * the screen unmount, so without a longer-lived observer that job would keep
 * fetching and writing all remaining tiles as a rider who has lost access.
 *
 * Two revocation sources are watched here (both at app entry, alongside the
 * other monitors):
 *   - `offline_maps` (paid entitlement, on the auth store) — granted→revoked.
 *   - `road_quality_overlay` (operator kill switch, on `systemSwitchCache`) —
 *     every offline tile is a quality MVT, so a bad-tile-build kill must also
 *     stop the pipeline even after the rider has left the offline screen.
 */

import { isFeatureEnabled } from "@tarmoto/shared";
import { useAuthStore } from "@/stores";
import { cancelAllOfflineDownloads } from "@/hooks/useOfflineRegions";
import {
  isFeatureKillSwitchActive,
  subscribeSystemSwitchStates,
} from "@/services/systemSwitchCache";

/**
 * Whether the snapshot currently grants `offline_maps`. A missing `features`
 * slice (legacy cached profile / pre-first-refresh) or a null user reads as NOT
 * granted — fail closed, matching `useFeature`.
 */
function offlineMapsGranted(state: {
  user?: { features?: unknown } | null;
}): boolean {
  const features = state.user?.features ?? null;
  return (
    features != null &&
    isFeatureEnabled(
      features as Parameters<typeof isFeatureEnabled>[0],
      "offline_maps",
    )
  );
}

/**
 * Start the monitor. Returns an unsubscribe that's safe to call on unmount.
 */
export function startOfflineDownloadRevocationMonitor(): () => void {
  const unsubscribeAuth = useAuthStore.subscribe((state, prev) => {
    // Cancel on any granted→not-granted transition: a downgrade, an operator
    // force-off, or a sign-out (null user) all mean the rider no longer has
    // offline access and the paid pipeline must stop. Gating on the PREVIOUS
    // snapshot being granted keeps this a transition — an already-locked rider
    // whose profile merely re-publishes never re-triggers a (harmless) cancel.
    if (offlineMapsGranted(prev) && !offlineMapsGranted(state)) {
      cancelAllOfflineDownloads();
    }
  });

  // Track the last observed state so we only cancel on the on→off transition
  // (fail-SAFE: unfetched cache reads ON, so the common path never cancels).
  let qualityOverlayOn = isFeatureKillSwitchActive("road_quality_overlay");
  const unsubscribeQuality = subscribeSystemSwitchStates(() => {
    const next = isFeatureKillSwitchActive("road_quality_overlay");
    if (qualityOverlayOn && !next) {
      cancelAllOfflineDownloads();
    }
    qualityOverlayOn = next;
  });

  return () => {
    unsubscribeAuth();
    unsubscribeQuality();
  };
}
