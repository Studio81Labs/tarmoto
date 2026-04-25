/**
 * Photo capture for hazard reports — US-4 AC #4.
 *
 * Encapsulates the runtime permission request and the actual picker
 * launch behind a single `capturePhoto(source)` call. Two reasons for
 * this seam:
 *
 *   1. The screen can render the same flow regardless of source
 *      (camera vs library) and decide what to do per `CaptureResult`
 *      status — UI doesn't need to know about Android's PermissionsAndroid
 *      or iOS Info.plist mechanics.
 *
 *   2. The native picker library hasn't landed yet (a follow-up will
 *      add `react-native-image-picker` and wire it into this module).
 *      Until then `defaultLauncher` returns `unavailable` so the UI
 *      degrades gracefully instead of crashing on a missing module.
 *      The permission gate is exercised regardless so the UI's
 *      "denied" branch is real today.
 *
 * Tests inject a fake launcher via `__setLauncherForTest`, which means
 * the screen's denial / cancel / capture branches can all be covered
 * without monkey-patching React Native.
 */

import { PermissionsAndroid, Platform } from "react-native";

export type PhotoSource = "camera" | "library";

export interface CapturedPhoto {
  uri: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
}

export type CaptureStatus =
  | "captured"
  | "cancelled"
  | "permission-denied"
  | "unavailable";

export interface CaptureResult {
  status: CaptureStatus;
  photo?: CapturedPhoto;
  source?: PhotoSource;
  /** Optional human-readable detail for `unavailable` / errors. */
  reason?: string;
}

type PhotoLauncher = (source: PhotoSource) => Promise<CaptureResult>;

async function defaultLauncher(): Promise<CaptureResult> {
  // Native picker integration is a follow-up — see related backend
  // file-upload work referenced from the US-4 issue. The UI handles
  // this status by collapsing to the no-photo path silently.
  return {
    status: "unavailable",
    reason: "Photo attachment will land alongside backend file upload.",
  };
}

let launcher: PhotoLauncher = defaultLauncher;

async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    // iOS prompts via Info.plist on first picker launch — no runtime
    // hook needed here. If the rider previously denied the prompt the
    // launcher itself surfaces the failure as `permission-denied`.
    return true;
  }
  try {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: "Camera access",
        message:
          "Tarmoto uses the camera to attach a photo to your hazard report.",
        buttonPositive: "Allow",
        buttonNegative: "Deny",
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    // If the platform module throws (very rare — usually a wrong-API
    // version mismatch), fail closed. The launcher won't fire and the
    // UI shows the standard permission-denied messaging.
    return false;
  }
}

export async function capturePhoto(
  source: PhotoSource,
): Promise<CaptureResult> {
  if (source === "camera") {
    const granted = await ensureCameraPermission();
    if (!granted) {
      return { status: "permission-denied", source };
    }
  }
  // Library access on modern Android (API 33+) uses the photo picker
  // which doesn't require a runtime permission prompt; older OS
  // versions are handled by the picker itself. Either way, we
  // delegate to the launcher.
  return launcher(source);
}

// ── Test hooks ──

export function __setLauncherForTest(next: PhotoLauncher): void {
  launcher = next;
}

export function __resetLauncherForTest(): void {
  launcher = defaultLauncher;
}
