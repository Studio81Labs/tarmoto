/**
 * Photo capture for hazard reports (US-4) and road reviews (US-25).
 *
 * Encapsulates the runtime permission request and the actual picker
 * launch behind a single `capturePhoto(source)` call. Two reasons for
 * this seam:
 *
 *   1. The screen can render the same flow regardless of source
 *      (camera vs library) and decide what to do per `CaptureResult`
 *      status — UI doesn't need to know about Android's
 *      PermissionsAndroid or iOS Info.plist mechanics.
 *
 *   2. Tests inject a fake launcher via `__setLauncherForTest` so the
 *      screen's denial / cancel / capture branches can all be covered
 *      without monkey-patching React Native or pulling in the native
 *      module under jest.
 *
 * The default launcher delegates to `react-native-image-picker`. When
 * the native module isn't available (jest, an older binary that hasn't
 * had `pod install` rerun) the launcher reports `unavailable` so the
 * UI can degrade rather than crash.
 */

import { PermissionsAndroid, Platform } from "react-native";
import { requestWithRationale } from "./permissions";
import { t as translate } from "@/i18n";

export type PhotoSource = "camera" | "library";

export interface CapturedPhoto {
  uri: string;
  fileName?: string | undefined;
  mimeType?: string | undefined;
  fileSize?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export type CaptureStatus =
  "captured" | "cancelled" | "permission-denied" | "unavailable";

export interface CaptureResult {
  status: CaptureStatus;
  photo?: CapturedPhoto;
  source?: PhotoSource;
  /** Optional human-readable detail for `unavailable` / errors. */
  reason?: string | undefined;
}

type PhotoLauncher = (source: PhotoSource) => Promise<CaptureResult>;

interface ImagePickerAsset {
  uri?: string;
  fileName?: string;
  type?: string;
  fileSize?: number;
  width?: number;
  height?: number;
}

interface ImagePickerResponse {
  didCancel?: boolean;
  errorCode?: string;
  errorMessage?: string;
  assets?: ImagePickerAsset[];
}

interface ImagePickerModule {
  launchCamera: (
    options: Record<string, unknown>,
  ) => Promise<ImagePickerResponse>;
  launchImageLibrary: (
    options: Record<string, unknown>,
  ) => Promise<ImagePickerResponse>;
}

function loadImagePicker(): ImagePickerModule | null {
  try {
    // Lazy require so jest (and any RN binary that predates the
    // dependency install) loads this module without crashing on the
    // missing native bridge. The launcher reports `unavailable` and
    // the UI degrades gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-image-picker") as ImagePickerModule;
    if (
      typeof mod?.launchCamera !== "function" ||
      typeof mod?.launchImageLibrary !== "function"
    ) {
      return null;
    }
    return mod;
  } catch {
    return null;
  }
}

async function defaultLauncher(source: PhotoSource): Promise<CaptureResult> {
  const picker = loadImagePicker();
  if (!picker) {
    return {
      status: "unavailable",
      source,
      reason: translate("Photo picker isn't available on this device."),
    };
  }

  const options = {
    mediaType: "photo" as const,
    // Cap on-disk size before upload to keep the multipart POST under
    // the backend's 5 MB limit (MAX_REVIEW_PHOTO_BYTES) on a forgiving
    // margin without recompressing twice.
    quality: 0.8,
    maxWidth: 2048,
    maxHeight: 2048,
    selectionLimit: 1,
    // saveToPhotos must stay false. On Android API ≤ 28 (still in
    // scope with `minSdkVersion = 24`) the camera-roll save requires
    // `WRITE_EXTERNAL_STORAGE`, which we don't request here — turning
    // it on would make `launchCamera` fail outright on those devices.
    // The captured photo lives at the temp URI we ship to the upload
    // endpoint, so persisting to the camera roll isn't necessary.
    saveToPhotos: false,
    // We render thumbnails directly from the local URI; base64 would
    // bloat memory and isn't needed for upload.
    includeBase64: false,
  };

  let response: ImagePickerResponse;
  try {
    response =
      source === "camera"
        ? await picker.launchCamera(options)
        : await picker.launchImageLibrary(options);
  } catch (error) {
    console.warn("Photo picker failed:", error);
    return {
      status: "unavailable",
      source,
      reason: translate("Photo picker isn't available on this device."),
    };
  }

  if (response.didCancel) return { status: "cancelled", source };
  if (response.errorCode === "permission") {
    return { status: "permission-denied", source };
  }
  if (response.errorCode || response.errorMessage) {
    console.warn(
      "Photo picker failed:",
      response.errorCode,
      response.errorMessage,
    );
    return {
      status: "unavailable",
      source,
      reason: translate("Photo picker isn't available on this device."),
    };
  }

  const asset = response.assets?.[0];
  if (!asset?.uri) return { status: "cancelled", source };

  return {
    status: "captured",
    source,
    photo: {
      uri: asset.uri,
      fileName: asset.fileName,
      mimeType: asset.type,
      fileSize: asset.fileSize,
      width: asset.width,
      height: asset.height,
    },
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
  // Generic copy across both call sites (US-4 hazard reports and
  // US-25 road reviews). When `capturePhoto` grows a third caller,
  // keep this neutral or thread the caller's purpose through the API.
  const status = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.CAMERA,
    rationale: {
      title: translate("Camera access"),
      message: translate(
        "Tarmoto uses the camera to attach photos to road reports and reviews.",
      ),
      whyOpenSettings: translate(
        "Camera access is currently blocked. Open Settings → Tarmoto and toggle Camera on to attach photos.",
      ),
    },
  });
  return status === "granted";
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
  const result = await launcher(source);
  if (result.status === "unavailable") {
    return {
      ...result,
      source,
      reason: translate("Photo picker isn't available on this device."),
    };
  }
  return result;
}

// ── Test hooks ──

export function __setLauncherForTest(next: PhotoLauncher): void {
  launcher = next;
}

export function __resetLauncherForTest(): void {
  launcher = defaultLauncher;
}
