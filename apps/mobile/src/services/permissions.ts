/**
 * Permissions service (issue #280).
 *
 * Wraps `PermissionsAndroid.request` with two pieces of UX every
 * permission flow in the app needs:
 *
 *   1. Rationale before the system prompt. Riders are far more
 *      likely to grant a permission when they understand why the app
 *      needs it, and on Android the OS prompt itself doesn't show our
 *      reason — only the bare permission label. We render an `Alert`
 *      first, in our copy, with an Allow / Cancel choice. Cancelling
 *      short-circuits — no system prompt, return "denied".
 *
 *   2. Open Settings recovery on `never_ask_again`. Once the rider
 *      checks "Don't ask again" on Android (or denies twice on iOS),
 *      the system never prompts again. The only way back is the app's
 *      Settings screen. We surface a second `Alert` with an "Open
 *      Settings" button that deep-links via `Linking.openSettings()`,
 *      and return "blocked" so the caller can disable the feature
 *      until the rider returns.
 *
 * iOS doesn't expose a `PermissionsAndroid.request`-style API for the
 * permissions we care about (location, motion, camera) — those prompts
 * are wired into the underlying API call (Geolocation.watchPosition,
 * react-native-image-picker, etc.) and surface the Info.plist purpose
 * string. So on iOS this service shows the rationale Alert (so iOS
 * riders get the same in-app context) and then returns "granted"
 * optimistically; the calling API surfaces its own denial state if
 * the rider rejects the system prompt.
 */

import { Alert, Linking, PermissionsAndroid, Platform } from "react-native";

export type PermissionStatus = "granted" | "denied" | "blocked";

export interface PermissionRationale {
  title: string;
  message: string;
  whyOpenSettings: string;
}

export interface RequestPermissionInput {
  androidPermission: (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];
  rationale: PermissionRationale;
}

function showRationale(
  rationale: PermissionRationale,
): Promise<"allow" | "cancel"> {
  return new Promise((resolve) => {
    Alert.alert(rationale.title, rationale.message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
      { text: "Allow", onPress: () => resolve("allow") },
    ]);
  });
}

function showBlockedRecovery(rationale: PermissionRationale): Promise<void> {
  return new Promise((resolve) => {
    Alert.alert("Permission needed", rationale.whyOpenSettings, [
      { text: "Not now", style: "cancel", onPress: () => resolve() },
      {
        text: "Open Settings",
        onPress: () => {
          void Linking.openSettings();
          resolve();
        },
      },
    ]);
  });
}

export async function requestWithRationale(
  input: RequestPermissionInput,
): Promise<PermissionStatus> {
  if (Platform.OS === "android") {
    // Skip the rationale Alert when the permission is already granted —
    // `PermissionsAndroid.request` returns GRANTED instantly on a cached
    // grant with no system prompt, so showing our rationale would be a
    // redundant tap-through every ride start. The AC ("rationale before
    // each system prompt") only applies when a prompt is actually about
    // to fire.
    const alreadyGranted = await PermissionsAndroid.check(
      input.androidPermission,
    );
    if (alreadyGranted) return "granted";
  }

  const consent = await showRationale(input.rationale);
  if (consent === "cancel") return "denied";

  if (Platform.OS !== "android") {
    // iOS surfaces the system prompt via the underlying API call (e.g.
    // `Geolocation.watchPosition`). The caller drives that next; we've
    // already shown our rationale, so return granted optimistically.
    //
    // Note: iOS doesn't expose a `PermissionsAndroid.check`-style API
    // for the permissions we care about, so we can't yet skip the
    // rationale on a cached iOS grant the way we do on Android. A
    // follow-up that adds `react-native-permissions` (or queries each
    // underlying API's status) would close that gap.
    return "granted";
  }

  const result = await PermissionsAndroid.request(input.androidPermission);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    await showBlockedRecovery(input.rationale);
    return "blocked";
  }
  return "denied";
}
