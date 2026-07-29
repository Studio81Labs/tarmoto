/**
 * Reactive read of a FREE-tier operator kill switch (`/config/flags`).
 *
 * `isFeatureKillSwitchActive` is a synchronous cache read — correct for
 * event-driven seams (a ride-start effect, a dispatch callback). But a
 * component that GATES A MOUNTED SURFACE on a kill switch (the CarPlay bands,
 * the map hazard layer, the navigation overlays) needs to RE-RENDER when an
 * operator flips the switch while it's mounted: `systemSwitchRefreshMonitor`
 * writes the fresh `/config/flags` map into MMKV outside React, which triggers
 * no re-render on its own. This hook subscribes to the cache's change
 * notification so a persisted `force_off` tears the surface down promptly — the
 * whole point of, e.g., the CarPlay crash-on-connect kill switch.
 *
 * Fail SAFE like the underlying read: ENABLED until an operator `force_off`
 * lands in the cache.
 */

import { useSyncExternalStore } from "react";
import type { FreeToggleFeatureKey } from "@tarmoto/shared";
import {
  isFeatureKillSwitchActive,
  subscribeSystemSwitchStates,
} from "@/services/systemSwitchCache";

export function useFeatureKillSwitchActive(key: FreeToggleFeatureKey): boolean {
  return useSyncExternalStore(subscribeSystemSwitchStates, () =>
    isFeatureKillSwitchActive(key),
  );
}
