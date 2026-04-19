/**
 * Leaf wrapper around `useCarPlayRideMirror` so the hook's high-frequency
 * ride-store subscriptions don't re-render the whole `RootNavigator`.
 *
 * The hook subscribes to six rapidly-changing selectors (`currentSpeed`,
 * `distance`, `duration`, `currentQuality`, etc.) — during an active
 * ride the location and sensor services push updates several times a
 * second. If the hook were called directly inside `RootNavigator`, each
 * tick would re-render the navigator (and trigger `screenOptions` to
 * rebuild as a fresh inline arrow on every render). Isolating the hook
 * inside a child component that returns `null` confines those re-renders
 * to a leaf — React doesn't propagate child renders up to parents.
 */

import { useCarPlayRideMirror } from "@/hooks";

export default function CarPlayRideMirror(): null {
  useCarPlayRideMirror();
  return null;
}
