/**
 * Reactive read of an operator SYSTEM switch (`sys_*`, from `/config/flags`).
 *
 * Sibling of `useFeatureKillSwitchActive`, and separate for the same reason the
 * companion keeps `SystemSwitchGate` apart from `KillSwitchGate`: the two take
 * DIFFERENT key types from different registry kinds. Widening either to a union
 * would let a `sys_*` key be passed where a per-rider entitlement belongs, which
 * compiles cleanly and answers the wrong question at runtime — on an operator
 * flip, the worst possible moment to find out.
 *
 * `isSystemSwitchEnabled` is a synchronous cache read, correct for event-driven
 * seams (a submit handler, a dispatch callback). A component that GATES A
 * MOUNTED SURFACE needs to re-render when an operator flips the switch while
 * it is on screen: `systemSwitchRefreshMonitor` writes the fresh map into MMKV
 * outside React and triggers no re-render on its own. This hook subscribes to
 * the cache's change notification so a persisted `force_off` tears the surface
 * down promptly.
 *
 * Fails SAFE like the underlying read: ENABLED until an operator `force_off`
 * lands in the cache.
 */

import { useSyncExternalStore } from "react";
import type { SystemFeatureKey } from "@tarmoto/shared";
import {
  isSystemSwitchEnabled,
  subscribeSystemSwitchStates,
} from "@/services/systemSwitchCache";

export function useSystemSwitchEnabled(key: SystemFeatureKey): boolean {
  return useSyncExternalStore(subscribeSystemSwitchStates, () =>
    isSystemSwitchEnabled(key),
  );
}
