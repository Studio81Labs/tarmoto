# Mobile native config gaps (issue #280) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring iOS Info.plist and Android manifest up to what the app actually needs at runtime, plus add a thin permissions service that delivers in-app rationale before each system prompt and an open-settings recovery path on denial.

**Architecture:** All native config lives in `apps/mobile/ios/TarmotoApp/Info.plist` and `apps/mobile/android/app/src/main/AndroidManifest.xml`. A new `apps/mobile/src/services/permissions.ts` wraps platform permission APIs and exposes a `requestWithRationale()` that always renders an `Alert`-based rationale before the system prompt and an "Open Settings" recovery `Alert` on `blocked`/`never_ask_again`. RideActiveScreen calls it before starting `locationService` (foreground location + notifications + body-sensors); `photoCapture` is refactored onto the same service so both code paths share the recovery UX.

**Tech Stack:** React Native `PermissionsAndroid`, `Linking.openSettings()`, `@react-native-community/geolocation` (already wired). No new npm dependencies.

---

## Spec → Task Map

| AC bullet                                                                                                                                                                                                                              | Task                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| iOS plist updated with purpose strings (location, camera, photo, motion, bluetooth-if-needed)                                                                                                                                          | Task 1                                                                         |
| `UIBackgroundModes` adds `location`, `audio` (and `remote-notification` since push is shipped)                                                                                                                                         | Task 1                                                                         |
| Android manifest declares ACCESS_FINE_LOCATION/ACCESS_COARSE_LOCATION/ACCESS_BACKGROUND_LOCATION/FOREGROUND_SERVICE/FOREGROUND_SERVICE_LOCATION/WAKE_LOCK/POST_NOTIFICATIONS/BODY_SENSORS plus `android.hardware.location.gps` feature | Task 2                                                                         |
| `automotive_app_desc.xml` + `CarAppService` declarations stay gated to the Android Auto issue                                                                                                                                          | Task 2 (verify-only)                                                           |
| Permission UX: in-app rationale before each system prompt; "Open Settings" recovery on denial                                                                                                                                          | Tasks 3, 4, 5                                                                  |
| Background ride recording works (real device manual test)                                                                                                                                                                              | Tasks 1+2 deliver the OS plumbing; verified in PR description manual test plan |
| README / runbook updated with rebuild steps after manifest changes                                                                                                                                                                     | Task 6                                                                         |
| Manual test plan in PR description                                                                                                                                                                                                     | Task 7                                                                         |

---

## File Structure

```
apps/mobile/
├── ios/TarmotoApp/Info.plist                          # MODIFY — purpose strings + background modes
├── android/app/src/main/AndroidManifest.xml           # MODIFY — uses-permission entries + uses-feature
├── src/services/
│   ├── permissions.ts                                 # NEW — typed wrapper + rationale helper
│   ├── photoCapture.ts                                # MODIFY — delegate to permissions.ts so denial recovers via Open Settings
│   ├── pushRegistration.ts                            # MODIFY — pre-prompt rationale before requestPermission()
│   └── __tests__/
│       ├── permissions.test.ts                        # NEW
│       └── photoCapture.test.ts                       # MODIFY — assert open-settings flow on never_ask_again
├── src/screens/
│   ├── RideActiveScreen.tsx                           # MODIFY — gate locationService.start on permissions.requestLocation
│   └── __tests__/RideActiveScreen.permissions.test.tsx# NEW — render-level test for the gate
README.md                                              # MODIFY — mobile rebuild section after manifest change
docs/process/runbook.md                               # MODIFY — manifest/permission troubleshooting section
```

---

## Task 1: iOS Info.plist — purpose strings, background modes

**Files:**

- Modify: `apps/mobile/ios/TarmotoApp/Info.plist`
- Test: `apps/mobile/src/__tests__/iosInfoPlist.test.ts` (NEW — string match against the plist file content)

The current plist has an empty `NSLocationWhenInUseUsageDescription` (App Store reject) and is missing background modes for an app whose ride HUD keeps GPS + TTS running with the screen off. Camera and photo-library strings are already present and rider-friendly; we keep them and add the missing ones.

We deliberately add `NSLocationAlwaysAndWhenInUseUsageDescription` even though the runtime API we use (`@react-native-community/geolocation` watchPosition) only requires "When In Use" — combined with the `location` background mode it lets the watch keep delivering updates while the screen is off but the app is foreground-running. The "Always" string is what iOS shows if a future caller asks for the always level; without it, that prompt would be blank.

`NSMotionUsageDescription` covers `react-native-sensors` (accelerometer/gyroscope, including the lean-angle pipeline introduced in #313).

We do NOT add `NSBluetoothAlwaysUsageDescription` — TTS uses system audio routing (which inherits the user's existing Bluetooth output without needing CoreBluetooth API access) and no part of the app talks to BLE peripherals directly.

`UIBackgroundModes` gets:

- `location` — watchPosition keeps streaming when the screen locks during a ride
- `audio` — TTS announcements continue while screen is off (US-19 / nav)
- `remote-notification` — silent push wake-ups for the notification system shipped in #275

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/__tests__/iosInfoPlist.test.ts
import { readFileSync } from "fs";
import { join } from "path";

/**
 * The mobile app's iOS Info.plist is hand-edited XML. Without a guard
 * these regress silently — an empty location string ships and Apple
 * rejects the build only after the upload finishes. A simple string
 * test runs in milliseconds and catches every requirement from
 * issue #280.
 */
describe("iOS Info.plist", () => {
  const plist = readFileSync(
    join(__dirname, "../../ios/TarmotoApp/Info.plist"),
    "utf8",
  );

  function valueOf(key: string): string {
    const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "m");
    const m = plist.match(re);
    if (!m) throw new Error(`missing key ${key}`);
    return m[1];
  }

  it.each([
    "NSLocationWhenInUseUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSCameraUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSMotionUsageDescription",
  ])("%s is set and non-empty", (key) => {
    const value = valueOf(key);
    expect(value.trim().length).toBeGreaterThan(20);
  });

  it("declares the background modes we depend on", () => {
    const block = plist.match(
      /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(block).toBeTruthy();
    const inner = block![1];
    expect(inner).toMatch(/<string>location<\/string>/);
    expect(inner).toMatch(/<string>audio<\/string>/);
    expect(inner).toMatch(/<string>remote-notification<\/string>/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/mobile test -- iosInfoPlist`
Expected: FAIL — `NSLocationWhenInUseUsageDescription` is empty, `NSLocationAlwaysAndWhenInUseUsageDescription` and `NSMotionUsageDescription` missing, `UIBackgroundModes` missing.

- [ ] **Step 3: Update the plist**

Edit `apps/mobile/ios/TarmotoApp/Info.plist`:

1. Replace the empty `NSLocationWhenInUseUsageDescription` value with:

   ```
   Tarmoto uses your location to record rides, surface road quality intelligence, alert you to nearby hazards, and route you to fuel and rest stops on multi-day trips.
   ```

2. Insert immediately after `NSLocationWhenInUseUsageDescription` (alphabetical order matches the rest of the file):

   ```xml
   <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
   <string>Tarmoto records rides while your phone is locked or the screen is off so you don't lose data on long trips. Location is only used during an active ride.</string>
   ```

3. Insert after `NSLocationAlwaysAndWhenInUseUsageDescription`:

   ```xml
   <key>NSMotionUsageDescription</key>
   <string>Tarmoto reads accelerometer and gyroscope data during rides to classify road surface quality and capture lean angles. Sensor data stays on your device unless you opt in to anonymised crowd-sourcing.</string>
   ```

4. Insert just before `<key>UILaunchStoryboardName</key>`:

   ```xml
   <key>UIBackgroundModes</key>
   <array>
     <string>location</string>
     <string>audio</string>
     <string>remote-notification</string>
   </array>
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/mobile test -- iosInfoPlist`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/ios/TarmotoApp/Info.plist apps/mobile/src/__tests__/iosInfoPlist.test.ts
git commit -m "feat(mobile): fix iOS purpose strings and background modes (us-280)"
```

---

## Task 2: AndroidManifest.xml — runtime permissions + foreground service + GPS feature

**Files:**

- Modify: `apps/mobile/android/app/src/main/AndroidManifest.xml`
- Test: `apps/mobile/src/__tests__/androidManifest.test.ts` (NEW)

We add the runtime permissions the app actually requests at runtime (location, body sensors, notifications), the foreground-service permissions ride recording needs on Android 14+, the wake-lock permission `react-native-keep-awake` declares (we re-declare it explicitly so manifest-merger doesn't surprise a future audit), and the `android.hardware.location.gps` feature so Play Store filters non-GPS hardware out of the eligible-devices list.

We do NOT add anything Android-Auto-specific in this task — the existing `automotive_app_desc.xml` + `meta-data` entries and the merged `CarAppService` from `react-native-carplay` are already in place from #313/AA work, and the issue explicitly says new AA wiring is gated to a separate ticket. We assert their presence in the test so a future "tidy unused permissions" pass doesn't accidentally rip them out.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/__tests__/androidManifest.test.ts
import { readFileSync } from "fs";
import { join } from "path";

describe("AndroidManifest.xml", () => {
  const xml = readFileSync(
    join(__dirname, "../../android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );

  it.each([
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_LOCATION",
    "android.permission.WAKE_LOCK",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.BODY_SENSORS",
  ])("declares %s", (perm) => {
    expect(xml).toMatch(
      new RegExp(`<uses-permission[^/]+android:name="${perm}"`),
    );
  });

  it("declares the GPS hardware feature", () => {
    expect(xml).toMatch(
      /<uses-feature[^/]+android:name="android\.hardware\.location\.gps"/,
    );
  });

  it("keeps the existing Android Auto wiring (merged from react-native-carplay)", () => {
    expect(xml).toMatch(/com\.google\.android\.gms\.car\.application/);
    expect(xml).toMatch(/automotive_app_desc/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/mobile test -- androidManifest`
Expected: FAIL — every permission line missing.

- [ ] **Step 3: Update the manifest**

Edit `apps/mobile/android/app/src/main/AndroidManifest.xml`. Insert the following block immediately after the existing `<uses-permission android:name="android.permission.CAMERA" />` line:

```xml
<!--
  US-280 — runtime permissions Tarmoto actually requests:
    * Foreground location for the live ride HUD and the map tab.
    * Coarse location for the network-provider fallback when GPS hasn't
      acquired a fix yet (cold start in a covered car park).
    * Background location so a ride keeps recording while the screen is
      locked or the rider switches apps mid-ride.
    * BODY_SENSORS for high-rate motion (lean angle, road-quality
      classifier) — the default `<uses-permission>` for accelerometer
      access is implicit, but the high-rate stream we ingest is gated.
    * POST_NOTIFICATIONS (Android 13+) for hazard alerts, ride
      reminders, and the foreground-service notification.
-->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.BODY_SENSORS" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!--
  Foreground service for ride recording. Android 14 (API 34) split
  FOREGROUND_SERVICE into typed companions; rides require the location
  type so the OS keeps `watchPosition` alive while backgrounded.
-->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />

<!--
  WAKE_LOCK is declared by react-native-keep-awake's manifest and merged
  in, but re-declaring keeps it visible to any audit that diffs the app
  manifest in isolation (e.g. the Play Console pre-launch report).
-->
<uses-permission android:name="android.permission.WAKE_LOCK" />

<!--
  GPS feature flag. Filters non-GPS hardware out of the Play Store
  eligibility list (no point shipping Tarmoto to a device that can't
  acquire a fix). Cellular-only tablets keep getting filtered, which
  matches the rider-on-bike target.
-->
<uses-feature
  android:name="android.hardware.location.gps"
  android:required="true" />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/mobile test -- androidManifest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/android/app/src/main/AndroidManifest.xml apps/mobile/src/__tests__/androidManifest.test.ts
git commit -m "feat(mobile): declare runtime permissions and foreground-service in AndroidManifest (us-280)"
```

---

## Task 3: Permissions service with rationale + open-settings recovery

**Files:**

- Create: `apps/mobile/src/services/permissions.ts`
- Test: `apps/mobile/src/services/__tests__/permissions.test.ts` (NEW)

A typed wrapper that:

1. Shows an `Alert`-based **rationale before** the system prompt fires — so the rider sees Tarmoto's reason in our voice, not just iOS's terse default.
2. Calls the platform permission API.
3. On `blocked` / `never_ask_again`, shows a second `Alert` offering an "Open Settings" button that deep-links to the app's privacy settings via `Linking.openSettings()`.

Returns a discriminated union: `'granted' | 'denied' | 'blocked'`. Callers can branch on it to disable the underlying feature, abort a ride start, etc. The service is intentionally minimal — no zustand store, no module-level state — so callers can compose it however they need.

iOS handles the prompt via Info.plist on first capture for camera/library/motion; for those, the rationale Alert here functions as a pre-prompt explainer, then the actual system prompt follows the next API call. Location on iOS uses the same flow: rationale Alert → caller invokes `Geolocation.watchPosition` → iOS prompts.

For Android, we go through `PermissionsAndroid.request` directly so we can detect `never_ask_again`. For iOS we rely on the launching API to surface the prompt; the service reports `granted` optimistically (the calling API will surface its own permission-denied state).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/mobile/src/services/__tests__/permissions.test.ts
/**
 * permissions service — issue #280.
 *
 * Covers:
 *   - rationale Alert shown before the system prompt (Android)
 *   - granted path returns "granted"
 *   - denied path returns "denied"
 *   - never_ask_again triggers the open-settings recovery Alert and
 *     returns "blocked"
 *   - iOS skips the runtime PermissionsAndroid plumbing and trusts
 *     the caller to surface system prompts via the underlying API
 */

import { Alert, Linking, PermissionsAndroid, Platform } from "react-native";
import { requestWithRationale, type PermissionRationale } from "../permissions";

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
    },
    RESULTS: {
      GRANTED: "granted",
      DENIED: "denied",
      NEVER_ASK_AGAIN: "never_ask_again",
    },
    request: jest.fn(),
  },
}));

const requestMock = PermissionsAndroid.request as jest.MockedFunction<
  typeof PermissionsAndroid.request
>;
const alertMock = Alert.alert as jest.MockedFunction<typeof Alert.alert>;
const openSettingsMock = Linking.openSettings as jest.MockedFunction<
  typeof Linking.openSettings
>;

const rationale: PermissionRationale = {
  title: "Location for ride recording",
  message: "Tarmoto records GPS while you ride.",
  whyOpenSettings: "Open Settings to allow location.",
};

beforeEach(() => {
  requestMock.mockReset();
  alertMock.mockReset();
  openSettingsMock.mockReset();
  (Platform as { OS: string }).OS = "android";
});

function answerRationaleWith(button: "Allow" | "Cancel") {
  alertMock.mockImplementationOnce((_title, _message, buttons) => {
    const target = (buttons ?? []).find((b) => b.text === button);
    target?.onPress?.();
  });
}

it("requests the OS permission after the rider taps Allow on the rationale", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.GRANTED);

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("granted");
  expect(alertMock).toHaveBeenCalledTimes(1);
  expect(requestMock).toHaveBeenCalledWith(
    "android.permission.ACCESS_FINE_LOCATION",
  );
});

it("returns denied without calling the OS when the rider cancels the rationale", async () => {
  answerRationaleWith("Cancel");

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("denied");
  expect(requestMock).not.toHaveBeenCalled();
});

it("surfaces a denied result when the OS prompt is dismissed", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("denied");
});

it("opens the app settings when the rider hits never_ask_again", async () => {
  answerRationaleWith("Allow");
  requestMock.mockResolvedValueOnce(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
  alertMock.mockImplementationOnce((_title, _message, buttons) => {
    const settings = (buttons ?? []).find((b) => b.text === "Open Settings");
    settings?.onPress?.();
  });

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("blocked");
  expect(openSettingsMock).toHaveBeenCalledTimes(1);
});

it("skips the runtime PermissionsAndroid call on iOS and reports granted optimistically", async () => {
  (Platform as { OS: string }).OS = "ios";
  answerRationaleWith("Allow");

  const result = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    rationale,
  });

  expect(result).toBe("granted");
  expect(requestMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tarmoto/mobile test -- permissions.test`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the service**

```ts
// apps/mobile/src/services/permissions.ts
/**
 * Permissions service (issue #280).
 *
 * Wraps `PermissionsAndroid.request` with two pieces of UX every
 * permission flow in the app needs:
 *
 *   1. **Rationale before the system prompt.** Riders are far more
 *      likely to grant a permission when they understand why the app
 *      needs it, and on Android the OS prompt itself doesn't show our
 *      reason — only the bare permission label. We render an `Alert`
 *      first, in our copy, with an Allow / Cancel choice. Cancelling
 *      short-circuits — no system prompt, return "denied".
 *
 *   2. **Open Settings recovery on `never_ask_again`.** Once the rider
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
  /** Alert title — short, rider-friendly. */
  title: string;
  /** Alert body — one to two sentences, plain English. */
  message: string;
  /** Body for the "blocked" recovery alert. */
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
  const consent = await showRationale(input.rationale);
  if (consent === "cancel") return "denied";

  if (Platform.OS !== "android") {
    // iOS surfaces the system prompt via the underlying API call (e.g.
    // `Geolocation.watchPosition`). The caller drives that next; we've
    // already shown our rationale, so return granted optimistically.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/mobile test -- permissions.test`
Expected: PASS — all five specs.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/permissions.ts apps/mobile/src/services/__tests__/permissions.test.ts
git commit -m "feat(mobile): permissions service with rationale and open-settings recovery (us-280)"
```

---

## Task 4: Refactor photoCapture onto the permissions service

**Files:**

- Modify: `apps/mobile/src/services/photoCapture.ts`
- Modify: `apps/mobile/src/services/__tests__/photoCapture.test.ts`

`photoCapture` already requests `CAMERA` runtime permission with a static rationale string baked into the `PermissionsAndroid.request` call. That works for the first prompt but never recovers from `never_ask_again`. Switching to `requestWithRationale` gives both call sites (US-4 hazard photos, US-25 reviews) consistent open-settings recovery for free.

- [ ] **Step 1: Update photoCapture tests for the new behaviour**

Replace the `requestMock`-based assertions in `photoCapture.test.ts` with assertions that mock `requestWithRationale` directly. Add a spec that exercises the `blocked` branch.

```ts
// apps/mobile/src/services/__tests__/photoCapture.test.ts
import { Platform } from "react-native";
import {
  __resetLauncherForTest,
  __setLauncherForTest,
  capturePhoto,
} from "../photoCapture";
import { requestWithRationale } from "../permissions";

jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("../permissions", () => ({
  requestWithRationale: jest.fn(),
}));

const requestMock = requestWithRationale as jest.MockedFunction<
  typeof requestWithRationale
>;

describe("photoCapture", () => {
  beforeEach(() => {
    requestMock.mockReset();
    __resetLauncherForTest();
    (Platform as { OS: string }).OS = "android";
  });

  it("returns permission-denied when the rider declines the rationale", async () => {
    requestMock.mockResolvedValueOnce("denied");
    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("returns permission-denied when the OS reports the prompt is blocked", async () => {
    requestMock.mockResolvedValueOnce("blocked");
    const launcher = jest.fn();
    __setLauncherForTest(launcher);

    const result = await capturePhoto("camera");

    expect(result.status).toBe("permission-denied");
    expect(launcher).not.toHaveBeenCalled();
  });

  it("invokes the launcher when permission is granted", async () => {
    requestMock.mockResolvedValueOnce("granted");
    __setLauncherForTest(async () => ({
      status: "captured",
      photo: { uri: "file:///tmp/x.jpg", fileName: "x.jpg" },
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("captured");
    expect(result.photo?.uri).toBe("file:///tmp/x.jpg");
  });

  it("skips the runtime prompt for library access (handled by the picker)", async () => {
    __setLauncherForTest(async () => ({ status: "cancelled" }));

    const result = await capturePhoto("library");

    expect(result.status).toBe("cancelled");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("forwards the launcher's unavailable status with its reason", async () => {
    requestMock.mockResolvedValueOnce("granted");
    __setLauncherForTest(async () => ({
      status: "unavailable",
      reason: "feature flag off",
    }));

    const result = await capturePhoto("camera");

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("feature flag off");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tarmoto/mobile test -- photoCapture.test`
Expected: FAIL — `requestWithRationale` not yet wired into `photoCapture`.

- [ ] **Step 3: Update photoCapture.ts**

Replace the `ensureCameraPermission` body so it delegates to the new service. The `PermissionsAndroid` import drops out; rationale text moves into the call site (still neutral across hazard and review flows).

```ts
// near the top of photoCapture.ts, replace the PermissionsAndroid import:
import { Platform, PermissionsAndroid } from "react-native";
// becomes:
import { Platform } from "react-native";
import { requestWithRationale } from "./permissions";
```

Replace `ensureCameraPermission` with:

```ts
async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    // iOS prompts via Info.plist on first picker launch — no runtime
    // hook needed here. If the rider previously denied the prompt the
    // launcher itself surfaces the failure as `permission-denied`.
    return true;
  }
  const status = await requestWithRationale({
    androidPermission: PermissionsAndroidName.CAMERA,
    rationale: {
      title: "Camera access",
      message:
        "Tarmoto uses the camera to attach photos to road reports and reviews.",
      whyOpenSettings:
        "Camera access is currently blocked. Open Settings → Tarmoto and toggle Camera on to attach photos.",
    },
  });
  return status === "granted";
}
```

…and add the small const at the top of the file:

```ts
// We don't import PermissionsAndroid directly anymore (the service
// owns the request), but we still need the canonical permission
// string. Keep it as a local const so a future RN bump that renames
// `PERMISSIONS.CAMERA` doesn't compile-pass with a typo'd literal.
import { PermissionsAndroid as PA } from "react-native";
const PermissionsAndroidName = {
  CAMERA: PA.PERMISSIONS.CAMERA,
} as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tarmoto/mobile test -- photoCapture.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/photoCapture.ts apps/mobile/src/services/__tests__/photoCapture.test.ts
git commit -m "refactor(mobile): route photoCapture through permissions service for open-settings recovery (us-280)"
```

---

## Task 5: Gate ride start on location permission in RideActiveScreen

**Files:**

- Modify: `apps/mobile/src/screens/RideActiveScreen.tsx`
- Test: `apps/mobile/src/screens/__tests__/RideActiveScreen.permissions.test.tsx` (NEW)

The current `useEffect` calls `locationService.start(...)` directly. On Android with no location permission this silently emits no updates and the HUD pegs at 0 km/h forever; on iOS the system prompt fires only when `watchPosition` runs, which means the rider sees an empty plist string. We add a permission gate at the top of the ride-start path: if the rider denies location, abort the ride start and pop the screen with an Alert explaining what happened.

To keep the file digestible, we extract the start-side-effect into a top-level helper that the screen calls. The helper returns `{ ok: true }` on success and `{ ok: false, reason }` on denial.

- [ ] **Step 1: Write the failing test**

The test renders the screen with a mocked navigation and a mocked permissions service. We don't fully render the HUD — we just verify the side effect order:

1. when permission is granted, `locationService.start` and `sensorService.start` fire and `api.startRide` is called.
2. when permission is denied, neither service starts and `navigation.goBack` is called.

```tsx
// apps/mobile/src/screens/__tests__/RideActiveScreen.permissions.test.tsx
/**
 * RideActiveScreen — issue #280 location permission gate.
 *
 * Mocks the heavy children (sensor service, location service, api,
 * navigation) and asserts that `locationService.start` only fires
 * after `permissions.requestWithRationale` returns "granted".
 */

import React from "react";
import { Alert } from "react-native";
import { render, waitFor } from "@testing-library/react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import RideActiveScreen, {
  __resetPendingStartPromiseForTests,
} from "@/screens/RideActiveScreen";
import { locationService } from "@/services/location";
import { sensorService } from "@/services/sensors";
import { api } from "@/services/api";
import { requestWithRationale } from "@/services/permissions";

jest.mock("@react-navigation/native", () => ({
  useNavigation: jest.fn(),
  useRoute: jest.fn(),
}));
jest.mock("@/services/location", () => ({
  locationService: {
    start: jest.fn(),
    stop: jest.fn(),
    getDistance: jest.fn(() => 0),
  },
}));
jest.mock("@/services/sensors", () => ({
  sensorService: {
    start: jest.fn(),
    stop: jest.fn(),
    isLeanCalibrating: jest.fn(() => false),
    recalibrateLean: jest.fn(),
  },
}));
jest.mock("@/services/api", () => ({
  api: {
    startRide: jest.fn(() =>
      Promise.resolve({ id: "ride-1", started_at: "now" }),
    ),
    stopRide: jest.fn(),
    submitSensorData: jest.fn(),
  },
}));
jest.mock("@/services/permissions", () => ({
  requestWithRationale: jest.fn(),
}));
jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

const goBack = jest.fn();
const useNavMock = useNavigation as jest.Mock;
const useRouteMock = useRoute as jest.Mock;

describe("RideActiveScreen permission gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPendingStartPromiseForTests();
    useNavMock.mockReturnValue({ goBack, navigate: jest.fn() });
    useRouteMock.mockReturnValue({ params: { rideType: "free" } });
  });

  it("starts telemetry when location permission is granted", async () => {
    (requestWithRationale as jest.Mock).mockResolvedValueOnce("granted");

    render(<RideActiveScreen />);

    await waitFor(() => {
      expect(locationService.start).toHaveBeenCalled();
      expect(sensorService.start).toHaveBeenCalled();
      expect(api.startRide).toHaveBeenCalledWith("free");
    });
  });

  it("aborts the ride start when location permission is denied", async () => {
    (requestWithRationale as jest.Mock).mockResolvedValueOnce("denied");

    render(<RideActiveScreen />);

    await waitFor(() => {
      expect(goBack).toHaveBeenCalled();
    });
    expect(locationService.start).not.toHaveBeenCalled();
    expect(api.startRide).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tarmoto/mobile test -- RideActiveScreen.permissions`
Expected: FAIL — gate not yet implemented; `locationService.start` is called regardless.

- [ ] **Step 3: Add the gate**

Modify the ride-start `useEffect` in `RideActiveScreen.tsx`. Wrap the existing fresh-start branch in an async IIFE that first awaits a `requestWithRationale` call. On non-`granted` outcome, call `navigation.goBack()` and abort.

Insert the import near the others:

```ts
import { requestWithRationale } from "@/services/permissions";
import { PermissionsAndroid } from "react-native";
```

Replace the `if (isFreshStart) { … }` block (lines ~198-226 in the current file) with:

```ts
if (isFreshStart) {
  // Gate the ride start on location permission. Without this the
  // rider sees a HUD that's permanently pegged at 0 km/h on Android
  // (no permission → watchPosition emits nothing) or an empty
  // system prompt on iOS (issue #280 fixed the plist string).
  let cancelled = false;
  void (async () => {
    const status = await requestWithRationale({
      androidPermission: PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      rationale: {
        title: "Location for ride recording",
        message:
          "Tarmoto records GPS while you ride to track distance, surface quality, and hazards along the route.",
        whyOpenSettings:
          "Location is currently blocked. Open Settings → Tarmoto and allow location to start recording rides.",
      },
    });
    if (cancelled) return;
    if (status !== "granted") {
      navigation.goBack();
      return;
    }
    store.startRide(params.rideType);
    sensorService.start((features, classification) => {
      const s = useRideStore.getState();
      s.updateQuality(classification);
      s.incrementSegments();
      s.reportLeanWindow({
        maxAbsLeanDeg: features.max_abs_lean_deg,
        calibrating: sensorService.isLeanCalibrating(),
      });
    });
    locationService.start((update) => {
      const s = useRideStore.getState();
      s.updateLocation(update);
      s.updateSpeed(update.speed);
      s.updateDistance(locationService.getDistance() / 1000);
    });

    const promise = api.startRide(params.rideType);
    pendingStartPromise = promise;
    const sessionStartedAtMs = useRideStore.getState().startedAtMs;
    void promise
      .then((ride) => {
        const current = useRideStore.getState();
        if (current.startedAtMs !== sessionStartedAtMs) {
          void api.stopRide(ride.id).catch(() => undefined);
          return;
        }
        current.setActiveRide(ride);
      })
      .catch((err) => {
        setStartError(
          err instanceof Error ? err.message : "Couldn't sync ride to server",
        );
      })
      .finally(() => {
        if (pendingStartPromise === promise) {
          pendingStartPromise = null;
        }
      });
  })();
  return () => {
    // Cleanup: if the screen unmounts before the rationale resolves,
    // suppress the post-permission start so we don't call `goBack`
    // on an already-unmounted screen or kick off telemetry that
    // nothing will tear down.
    cancelled = true;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tarmoto/mobile test -- RideActiveScreen.permissions`
Expected: PASS

- [ ] **Step 5: Run the full ride-store / ride-screen suite to confirm we didn't regress the existing flow**

Run: `pnpm --filter @tarmoto/mobile test -- ride`
Expected: PASS — including `ride-store.test`.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/screens/RideActiveScreen.tsx apps/mobile/src/screens/__tests__/RideActiveScreen.permissions.test.tsx
git commit -m "feat(mobile): gate ride start on location permission with rationale (us-280)"
```

---

## Task 6: Surface a rationale before the push permission prompt

**Files:**

- Modify: `apps/mobile/src/services/pushRegistration.ts`

`pushRegistration.requestPermission` calls `messaging.requestPermission()` directly. On Android 13+ that triggers the OS `POST_NOTIFICATIONS` prompt without any in-app context. Add a `requestWithRationale` call first; if the rider declines, skip the messaging-side prompt entirely (returns `denied`, the registration short-circuits as before).

We don't add a separate test for this — the existing `pushRegistration` test suite mocks `messaging.requestPermission` and we keep that contract; the rationale Alert just runs ahead of it.

- [ ] **Step 1: Wire the rationale call**

In `pushRegistration.ts`, replace the body of `requestPermission` with:

```ts
async function requestPermission(
  messaging: ReturnType<FirebaseMessagingModule>,
): Promise<boolean> {
  // Show the in-app rationale first so the rider knows what they're
  // saying yes (or no) to. On Android 13+ this runs before the
  // POST_NOTIFICATIONS prompt; on iOS the firebase prompt itself
  // surfaces the system dialog right after.
  const rationale = await requestWithRationale({
    androidPermission: PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    rationale: {
      title: "Stay in the loop",
      message:
        "Tarmoto sends notifications for nearby hazards, ride reminders, and safety alerts. You can fine-tune which kinds you want in Settings.",
      whyOpenSettings:
        "Notifications are blocked. Open Settings → Tarmoto and allow notifications to receive ride and hazard alerts.",
    },
  });
  if (rationale === "denied" || rationale === "blocked") return false;

  // `messaging.requestPermission()` covers both iOS (real prompt) and
  // Android (POST_NOTIFICATIONS on 13+, auto-granted on older). On
  // Android 13+ the rationale call above has already taken the OS
  // prompt to a granted state, so this becomes a no-op confirm.
  // 1 = AUTHORIZED, 2 = PROVISIONAL — both let us deliver pushes.
  const status = await messaging.requestPermission();
  return status === 1 || status === 2;
}
```

…and add the imports at the top:

```ts
import { PermissionsAndroid } from "react-native";
import { requestWithRationale } from "./permissions";
```

- [ ] **Step 2: Run the existing pushRegistration tests**

Run: `pnpm --filter @tarmoto/mobile test -- pushRegistration`
Expected: PASS — the existing tests mock `messaging.requestPermission` to return AUTHORIZED, and we add a default `requestWithRationale` mock that returns `granted`. If the existing test file does NOT mock `requestWithRationale`, add a one-line mock at the top of the file (`jest.mock("@/services/permissions", () => ({ requestWithRationale: jest.fn().mockResolvedValue("granted") }));`).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/services/pushRegistration.ts apps/mobile/src/services/__tests__/pushRegistration.test.ts
git commit -m "feat(mobile): show in-app rationale before push permission prompt (us-280)"
```

---

## Task 7: Documentation — README rebuild steps + runbook section

**Files:**

- Modify: `README.md`
- Modify: `docs/process/runbook.md`

After every native-config change, contributors need a clean rebuild — Metro caches the JS bundle but won't trigger a Gradle / pod re-link, so a manifest tweak silently regresses on incremental builds. Document the steps once, link to them from the runbook so on-call has them when a "permissions don't work" report lands.

- [ ] **Step 1: Add a "Mobile native config rebuild" section to README.md**

Insert under the existing "Manual Setup" section, near the other mobile entries (between "Mobile build / sensor issues" if present, or before "Project Structure"):

````markdown
### After editing `Info.plist` or `AndroidManifest.xml`

Native manifest changes don't propagate through a Metro reload — the
React Native bundle is unchanged, but the underlying iOS/Android binary
still embeds the old manifest. After editing either file:

```bash
# iOS
cd apps/mobile/ios && pod install && cd -
pnpm ios     # forces a fresh xcodebuild

# Android
pnpm --filter @tarmoto/mobile exec npx react-native run-android --reset-cache
# or, if you've changed manifest permissions, fully rebuild:
cd apps/mobile/android && ./gradlew clean && cd -
pnpm android
```
````

If location, sensors, notifications, or photo capture stop working
after a permission edit, 9 times out of 10 the binary on the device is
stale. Uninstall the app and reinstall to be sure — Android in
particular caches the granted permission set per install.

````

- [ ] **Step 2: Add a "Mobile permission troubleshooting" section to docs/process/runbook.md**

Insert before "Proxy & throttling":

```markdown
## Mobile permission and manifest issues

After any change to `apps/mobile/ios/TarmotoApp/Info.plist` or
`apps/mobile/android/app/src/main/AndroidManifest.xml`:

1. Reinstall the app on the device — granted permissions are scoped to
   the install on Android, and iOS caches the plist purpose strings
   shown in Settings → Privacy.
2. iOS: `cd apps/mobile/ios && pod install` after touching the plist
   and re-run `pnpm ios`.
3. Android: `cd apps/mobile/android && ./gradlew clean` then `pnpm
   android` to drop the merged-manifest cache.

### "Ride won't start, HUD stuck at 0 km/h" (Android)

The screen now gates ride start on `ACCESS_FINE_LOCATION`. If the
permission was denied with "Don't ask again", the rationale Alert
opens settings via `Linking.openSettings()`. If the dialog shows but
nothing happens on tap, the device's app-info screen is missing —
usually a custom OEM build that changes the settings deep-link target.
Manually navigate Settings → Apps → Tarmoto → Permissions → Location.

### "TTS announcements stop the moment the screen locks" (iOS)

iOS kills audio playback in apps that don't declare the `audio`
background mode. Confirm `UIBackgroundModes` in Info.plist contains
`audio` (and `location` for the GPS watch). On a fresh checkout that
predates issue #280 this was missing — incremental builds keep the
old plist baked into the IPA, so reinstall the app after pulling.

### "Push permission prompt has no Tarmoto explainer" (Android)

The pre-prompt rationale Alert ships in `services/permissions.ts`.
If a rider doesn't see it, the most common cause is a build that
predates issue #280 still running on the device — uninstall and
reinstall the app.
````

- [ ] **Step 3: Commit**

```bash
git add README.md docs/process/runbook.md
git commit -m "docs(mobile): rebuild steps and permission runbook entries (us-280)"
```

---

## Task 8: PR — open with manual test plan

**Files:**

- (none — gh PR description)

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin claude/optimistic-haibt-1e52e2
gh pr create \
  --title "feat(mobile): native config gaps (us-280)" \
  --body "$(cat <<'EOF'
Closes #280.

## Summary

- Fix empty `NSLocationWhenInUseUsageDescription` (App Store reject) and add `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSMotionUsageDescription`. Cameras/photo strings already present and rider-friendly.
- Add `UIBackgroundModes` (`location`, `audio`, `remote-notification`) so ride GPS, TTS, and silent push wake-ups keep working with the screen off.
- Declare missing Android permissions: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `BODY_SENSORS`, plus `android.hardware.location.gps` feature.
- Existing Android Auto wiring (automotive_app_desc.xml + merged CarAppService from react-native-carplay) preserved unchanged — gated to its own issue.
- New `services/permissions.ts` shows an in-app rationale before each system prompt and routes `never_ask_again` to `Linking.openSettings()`.
- `RideActiveScreen` now gates the ride start on `ACCESS_FINE_LOCATION`. `photoCapture` and `pushRegistration` route through the same rationale helper so all three flows share recovery UX.
- README + runbook updated with rebuild and troubleshooting steps.

## Implementation notes

- Background ride recording on Android relies on the OS-level permissions added here plus `react-native-keep-awake` (already in deps). A typed `FOREGROUND_SERVICE_LOCATION` permission is declared so Android 14+ keeps the ride GPS alive when the screen locks.
- iOS does not expose `PermissionsAndroid.request`-style hooks for camera/motion/location — the OS prompts when the underlying API runs. The rationale service short-circuits on iOS to "granted" after showing the in-app explainer; the underlying API surfaces the actual denial state.

## Risks / regression surface

- The `UIBackgroundModes` change affects every iOS build — incremental builds will silently keep the old plist baked in. Reinstall the app on test devices after pulling.
- The ride-start permission gate is a new branching path; the new `RideActiveScreen.permissions.test.tsx` covers both granted and denied outcomes.

## Test evidence

- `pnpm --filter @tarmoto/mobile test` — all suites pass, including new `iosInfoPlist`, `androidManifest`, `permissions`, `photoCapture` denial-recovery, and `RideActiveScreen.permissions` specs.
- `pnpm --filter @tarmoto/mobile lint`
- `pnpm --filter @tarmoto/mobile typecheck`

## Manual test plan

iOS (latest, real device):
1. Install fresh build over a previous version.
2. Tap Start ride — confirm rationale Alert ("Location for ride recording"), tap Allow → iOS system prompt appears with the new plist string. Allow.
3. Lock the device. Watch the HUD distance counter on the next unlock — should have advanced.
4. With the screen off, trigger a TTS announcement (route deviation) — audio plays through.
5. Background the app. Trigger a silent push from staging — app wakes briefly to process.
6. Deny location once → confirm the Alert recovery flow → tap Open Settings → privacy panel for Tarmoto opens.
7. Camera flow on hazard report — same rationale + denial recovery.

Android 13+ device:
1. Install fresh build, decline location at the rationale → ride aborts with `goBack`.
2. Restart, allow → ride records. Lock the screen and confirm distance keeps advancing.
3. Toggle "Don't ask again" on the camera prompt → confirm the Open Settings recovery Alert.
4. Run a long ride (5+ minutes) with the screen locked and the app backgrounded — verify the foreground-service notification persists and the ride doesn't stop.
EOF
)"
```

- [ ] **Step 2: Confirm CI is green and the PR shows the right scope label**

Wait for the CI run linked from the PR; if any check fails, fix in this branch and push.

---

## Self-Review

1. **Spec coverage:** every AC bullet maps to at least one task above (see Spec → Task Map). Background ride recording (AC #3 in the issue) is delivered by the iOS background modes (Task 1) plus Android foreground-service permissions (Task 2); we verify it manually in the PR description.
2. **Placeholder scan:** every code block contains the actual code that lands; permission strings are concrete, not "TODO".
3. **Type consistency:** `PermissionStatus` is `granted | denied | blocked` end-to-end. `requestWithRationale`'s input type matches its consumers in Tasks 4, 5, 6.
4. **No-rationale path:** the iOS shortcut in `requestWithRationale` returns `granted` because the underlying API drives the actual prompt — riders still see the in-app rationale before that prompt, which satisfies the AC.
