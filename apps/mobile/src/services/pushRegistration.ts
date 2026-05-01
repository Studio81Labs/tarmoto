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
import axios, { type AxiosInstance } from "axios";
import { API_BASE_URL } from "@/config";

type FirebaseMessagingModule =
  typeof import("@react-native-firebase/messaging").default;

let cachedMessaging: ReturnType<FirebaseMessagingModule> | null = null;
let cachedToken: string | null = null;
let unsubscribeTokenRefresh: (() => void) | null = null;
/**
 * Monotonic counter that flips whenever a new auth session begins or
 * the previous one is torn down. `registerForPush` snapshots this at
 * entry and refuses to commit any session-scoped state (cached token,
 * onTokenRefresh subscription) once the snapshot has gone stale.
 *
 * This closes a race that would otherwise survive a quick login →
 * logout: the in-flight register completes after `unregisterPush`
 * has already returned (because `cachedToken` was still null at
 * that moment), then sets `cachedToken` to the device handle. The
 * next sign-in's register call sees `cachedToken === token` and
 * skips its `POST /me/devices`, so the new user is never bound to
 * this device on the backend — and notifications keep flowing for
 * whichever account the in-flight POST happened to authenticate as.
 */
let registrationSession = 0;

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
  /**
   * Optional explicit bearer for the DELETE in `unregisterPush`. The
   * logout flow snapshots the access token before clearing MMKV and
   * passes it through here so the request can authenticate even after
   * the local credentials have been wiped (and even if a concurrent
   * relogin has populated MMKV with a different user's token).
   */
  bearer?: string | undefined;
}

/**
 * Register the current device for push. Safe to call any number of
 * times — repeats short-circuit when the token hasn't changed AND
 * no logout has happened in between.
 */
export async function registerForPush(api: PushRegistrationApi): Promise<void> {
  const messaging = loadMessaging();
  if (!messaging) return;

  // Snapshot the session at entry. If `unregisterPush` runs before
  // we finish, the session number bumps and we abort before writing
  // any session-scoped state — see `registrationSession` for why.
  const mySession = registrationSession;

  try {
    const granted = await requestPermission(messaging);
    if (!granted || mySession !== registrationSession) return;

    const token = await messaging.getToken();
    if (!token || mySession !== registrationSession) return;

    if (cachedToken === token) {
      // Already registered this token in the current session.
      return;
    }

    const platform: "ios" | "android" =
      Platform.OS === "ios" ? "ios" : "android";

    const appVersion = await safeAppVersion();
    if (mySession !== registrationSession) return;

    await api.client.post("/me/devices", {
      platform,
      token,
      app_version: appVersion,
    });

    // Final session check before mutating module state. A logout
    // that fired during the POST round-trip must NOT leave the
    // cache pointing at this token — the next login would otherwise
    // see `cachedToken === token` and skip its own registration.
    if (mySession !== registrationSession) return;
    cachedToken = token;

    // Re-register on token refresh (post-install rotations,
    // re-installs, occasional Firebase rotations on upgrade).
    if (unsubscribeTokenRefresh) {
      unsubscribeTokenRefresh();
      unsubscribeTokenRefresh = null;
    }
    unsubscribeTokenRefresh = messaging.onTokenRefresh((nextToken: string) => {
      // Same gate on the refresh path — once the session has been
      // torn down, refresh callbacks must stop posting under the
      // old user's account.
      if (mySession !== registrationSession) return;
      // Re-read the app version at refresh time. Firebase rotates
      // tokens after re-installs and on app upgrade, so capturing
      // `appVersion` from the closure would persist a stale build
      // string into the backend row — confusing analytics and any
      // version-gated dispatch decisions downstream.
      void safeAppVersion()
        .then((latestVersion) =>
          api.client.post("/me/devices", {
            platform,
            token: nextToken,
            app_version: latestVersion,
          }),
        )
        .then(() => {
          if (mySession !== registrationSession) return;
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
 *
 * Always invalidates the registration session up front, even when
 * there's no `cachedToken` to DELETE: an in-flight `registerForPush`
 * (the early-logout-after-login race) must be prevented from
 * setting `cachedToken` after we return, otherwise the next login
 * would see the same device handle in the cache and skip its
 * own `POST /me/devices`.
 */
export async function unregisterPush(api: PushRegistrationApi): Promise<void> {
  registrationSession += 1;

  const token = cachedToken;
  cachedToken = null;
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }

  if (!token) return;

  // Use a bare `axios.delete` rather than the shared client so the
  // request bypasses the instance interceptors entirely. The 401
  // response interceptor on the shared client triggers a refresh +
  // retry on auth failure — fine for normal traffic, but on the
  // logout path it spins into an infinite loop:
  //
  //   1. Snapshotted bearer is expired → server returns 401.
  //   2. Interceptor calls `refreshToken()`.
  //   3. If a different user logged in between `clearTokens()` and
  //      the 401 landing, MMKV holds their refresh token, so refresh
  //      succeeds.
  //   4. Interceptor retries `error.config` — which still carries
  //      our explicit Authorization header — and the request
  //      interceptor's "honour explicit bearer" path skips MMKV,
  //      so the retry uses the same expired snapshot, 401s again,
  //      and the loop never terminates.
  //
  // The bare axios call has no interceptors, so a 401 just rejects
  // and the surrounding catch swallows it. The backend's dispatch
  // path will soft-delete the token on its next attempted send
  // anyway — the DELETE is best-effort cleanup, not a load-bearing
  // operation.
  try {
    await axios.delete(`${API_BASE_URL}/me/devices`, {
      // The token rides in the request body, not the URL — keeps a
      // ~150-char opaque credential out of access logs and sidesteps
      // Express path-match edge cases for variable-length values.
      data: { token },
      timeout: 15_000,
      headers: api.bearer
        ? { Authorization: `Bearer ${api.bearer}` }
        : undefined,
    });
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
  registrationSession = 0;
  if (unsubscribeTokenRefresh) {
    unsubscribeTokenRefresh();
    unsubscribeTokenRefresh = null;
  }
}
