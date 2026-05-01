/**
 * Push registration service.
 *
 * On login the app requests notification permission, asks Firebase
 * messaging for the device-issued token (Firebase wraps APN on iOS
 * and FCM on Android, so the same SDK call works on both), and
 * posts the token to `POST /me/devices`. The backend keys on
 * `(user_id, token)` so re-registering the same device is a no-op
 * upsert that also clears any stale soft-delete from the previous
 * sign-in.
 *
 * On logout the app calls `DELETE /me/devices/:token` so the
 * backend stops fanning push at a device the user has signed out of.
 *
 * On token refresh — Firebase rotates tokens after re-installs and
 * occasionally on app upgrade — we re-register so the dispatch path
 * always has the current handle.
 *
 * Every call is best-effort: a missing native module (Jest / Metro
 * before native build), a permission denial, or a backend HTTP
 * failure logs a warning and returns, never throwing into the
 * caller. The auth flow MUST keep working even if push
 * registration fails — riders who said "no" to notifications can
 * still use the app.
 */

import { Platform } from "react-native";
import DeviceInfo from "react-native-device-info";
import type { AxiosInstance } from "axios";

type FirebaseMessagingModule =
  typeof import("@react-native-firebase/messaging").default;

let cachedMessaging: ReturnType<FirebaseMessagingModule> | null = null;
let cachedToken: string | null = null;
let unsubscribeTokenRefresh: (() => void) | null = null;

function loadMessaging(): ReturnType<FirebaseMessagingModule> | null {
  if (cachedMessaging) return cachedMessaging;
  try {
    // Lazy require so the module stays importable in environments
    // without the native binding (Jest, Metro pre-build).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-firebase/messaging") as {
      default: FirebaseMessagingModule;
    };
    cachedMessaging = mod.default();
    return cachedMessaging;
  } catch {
    return null;
  }
}

async function requestPermission(
  messaging: ReturnType<FirebaseMessagingModule>,
): Promise<boolean> {
  // `messaging.requestPermission()` covers both iOS (real prompt) and
  // Android (POST_NOTIFICATIONS on 13+, auto-granted on older).
  // 1 = AUTHORIZED, 2 = PROVISIONAL — both let us deliver pushes.
  const status = await messaging.requestPermission();
  return status === 1 || status === 2;
}

export interface PushRegistrationApi {
  client: AxiosInstance;
}

/**
 * Register the current device for push. Safe to call any number of
 * times — repeats short-circuit when the token hasn't changed.
 */
export async function registerForPush(api: PushRegistrationApi): Promise<void> {
  const messaging = loadMessaging();
  if (!messaging) return;

  try {
    const granted = await requestPermission(messaging);
    if (!granted) return;

    const token = await messaging.getToken();
    if (!token) return;

    if (cachedToken === token) {
      // Already registered this token in the current session.
      return;
    }

    const platform: "ios" | "android" =
      Platform.OS === "ios" ? "ios" : "android";

    const appVersion = await safeAppVersion();

    await api.client.post("/me/devices", {
      platform,
      token,
      app_version: appVersion,
    });
    cachedToken = token;

    // Re-register on token refresh (post-install rotations,
    // re-installs, occasional Firebase rotations on upgrade).
    if (unsubscribeTokenRefresh) {
      unsubscribeTokenRefresh();
      unsubscribeTokenRefresh = null;
    }
    unsubscribeTokenRefresh = messaging.onTokenRefresh((nextToken: string) => {
      void api.client
        .post("/me/devices", {
          platform,
          token: nextToken,
          app_version: appVersion,
        })
        .then(() => {
          cachedToken = nextToken;
        })
        .catch(() => {
          // Best-effort — see module comment.
        });
    });
  } catch (err) {
    // Surface in logs only; never break auth.
    // eslint-disable-next-line no-console
    console.warn("[pushRegistration] register failed", err);
  }
}

/**
 * Unregister the current device on sign-out. Idempotent — safe to
 * call when no token has ever been registered.
 */
export async function unregisterPush(api: PushRegistrationApi): Promise<void> {
  if (!cachedToken) return;
  const token = cachedToken;
  cachedToken = null;
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }
  try {
    await api.client.delete(`/me/devices/${encodeURIComponent(token)}`);
  } catch {
    // Best-effort — backend will eventually soft-delete the token
    // on next dispatch failure if this call never lands.
  }
}

async function safeAppVersion(): Promise<string | undefined> {
  try {
    return DeviceInfo.getReadableVersion();
  } catch {
    return undefined;
  }
}

/** Expose for tests so they can clear cached registration state. */
export function __resetPushRegistrationForTesting(): void {
  cachedToken = null;
  cachedMessaging = null;
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }
}
