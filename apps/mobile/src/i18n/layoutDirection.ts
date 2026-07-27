import { I18nManager } from "react-native";
import type { LocaleDirection } from "@tarmoto/shared";

type LayoutDirectionManager = Pick<
  typeof I18nManager,
  "allowRTL" | "forceRTL" | "isRTL" | "swapLeftAndRightInRTL"
>;

/**
 * Keep React Native's logical start/end layout aligned with the active
 * language. React Native requires an app restart when forceRTL changes the
 * native direction; returning false lets a future locale picker surface that
 * restart requirement without duplicating the synchronization logic.
 */
export function syncLayoutDirection(
  direction: LocaleDirection,
  manager: LayoutDirectionManager = I18nManager,
): boolean {
  const shouldUseRtl = direction === "rtl";
  manager.allowRTL(true);
  manager.swapLeftAndRightInRTL(true);
  if (manager.isRTL !== shouldUseRtl) {
    manager.forceRTL(shouldUseRtl);
  }
  return manager.isRTL === shouldUseRtl;
}
