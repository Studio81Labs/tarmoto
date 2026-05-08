# CarPlay & Android Auto runbook (US-17)

This document captures the current state of Tarmoto's head-unit
support, what shipped under issue #498, what remains, and the manual
test plan for verifying behaviour on a connected car.

## Audit findings (as of issue #498)

### iOS — CarPlay

| Area                                                 | State after #498                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/mobile/ios/TarmotoApp/TarmotoApp.entitlements` | ✅ Created with `com.apple.developer.carplay-maps`                                                                                                                                                                                                                                                                                                     |
| `Info.plist` `UIApplicationSceneManifest`            | ✅ Declares the `CPTemplateApplicationSceneSessionRoleApplication` scene pointing at `RNCarPlaySceneDelegate` (contributed by `react-native-carplay`)                                                                                                                                                                                                  |
| Apple navigation entitlement approval                | 🚧 Paperwork in flight. Required for TestFlight under the `carplay-maps` entitlement. ~2 weeks lead time.                                                                                                                                                                                                                                              |
| Xcode project (`project.pbxproj`)                    | ⚠️ Manual step — open Xcode and reference `TarmotoApp.entitlements` under Signing & Capabilities → Code Signing Entitlements. Programmatic edits to `pbxproj` are too risky to automate.                                                                                                                                                               |
| `CPMapTemplate` rendering                            | ✅ Provided by the `react-native-carplay` package's `MapTemplate`. We feed it a React component surface (`VehicleDisplaySurface`) that re-renders the route polyline, current location, and maneuver banner from the Zustand vehicle-display store.                                                                                                    |
| `CPAlertTemplate` for hazards                        | ✅ Wired through `services/carplay.ts` → `presentHazardAlertOnVehicleDisplay`. Confirm/dismiss callbacks; explicit dismiss is sticky for the session.                                                                                                                                                                                                  |
| Quick-launch Commute (CPListTemplate)                | ✅ Wired through `services/carplay.ts` → `mountQuickActions`. Pre-ride row dispatches `tarmoto://commute/start`, which the React Navigation linking config routes onto the existing CommuteScreen.                                                                                                                                                     |
| Voice announcements                                  | ✅ TTS routes through CarPlay's audio session whenever CarPlay is connected (no double-speak — the `react-native-tts` Bluetooth headset routing already prefers the active CarPlay session). Verified by the existing `tts.ts` ducking + `setIgnoreSilentSwitch("ignore")` configuration. Hardware verification still required (see manual test plan). |

### Android — Android Auto

| Area                                                                                   | State after #498                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `androidx.car.app:app` Gradle dependency                                               | ✅ Pinned to 1.4.0 in `apps/mobile/android/app/build.gradle`                                                                                                                    |
| `automotive_app_desc.xml`                                                              | ✅ Declares templated experience (was already present)                                                                                                                          |
| `androidx.car.app.minCarApiLevel` meta-data                                            | ✅ Set to API level 5 (was already present)                                                                                                                                     |
| `<service>` for `androidx.car.app.CarAppService`                                       | ✅ Contributed by `react-native-carplay`'s manifest merge. Re-declaring would duplicate the component name and break the build.                                                 |
| `Screen` / `NavigationScreen` subclasses                                               | ✅ Contributed by `react-native-carplay`. Tarmoto pushes templates from JS via the package's screen manager — no Kotlin subclass needed.                                        |
| ProGuard keep rules                                                                    | ✅ Added in `proguard-rules.pro` so release builds don't strip the AA reflection surface.                                                                                       |
| `AndroidManifest.xml` `<uses-feature android:name="android.hardware.type.automotive">` | ✅ `required="false"` so phones (the primary target) keep passing the Play Console eligibility check                                                                            |
| Hazard markers on AA map                                                               | ✅ Same alert template surface as CarPlay via `presentHazardAlertOnVehicleDisplay`                                                                                              |
| Voice announcements                                                                    | ✅ TTS routes via the `STREAM_VOICE_CALL` audio stream (existing config in `services/tts.ts`), which AA prefers. Hardware verification still required.                          |
| Notification icon for AA                                                               | 🚧 Follow-up. AA host expects a dedicated white-on-transparent icon resource for app branding; current `mipmap/ic_launcher` is the colour app icon. Tracked outside this issue. |

### Cross-cutting

| Area                                                | State after #498                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `useCarPlayRideMirror` as the single bridge (AC #6) | ✅ Refactored to subscribe to ride store + hazard store, dispatch into `services/carplay.ts` (ride board + hazard alerts + quick actions) |
| Platform-agnostic `services/carplay.ts` controller  | ✅ Existing pattern — iOS / Android / no-op bridges interchangeable behind `VehicleStatusBridge`                                          |

## What deliberately did NOT ship under #498

- **Apple CarPlay entitlement approval.** Engineering work is complete; Apple paperwork is independent and can take ~2 weeks. Until approved, iOS builds installed via TestFlight will start without CarPlay scene attachment (the manifest entry is silently ignored without the entitlement).
- **`pbxproj` reference to the entitlements file.** Manual one-time Xcode step. Documented above.
- **Android Auto-specific notification icon.** Branding follow-up; the AA host still mounts our app without it (it falls back to the regular launcher icon).
- **Hardware-on-bike verification.** Requires either real CarPlay/AA-equipped car, the Apple CarPlay simulator, or Android Auto's Desktop Head Unit (DHU). See manual test plan below.

## Manual test plan

**Goal:** drive a 10 km recorded ride with the phone connected to a head unit (or simulator), verifying every UI element updates as documented.

### Prerequisites

- iOS device running iOS 17+ with CarPlay-capable head unit OR Apple's `CarPlaySimulator.app` from Additional Tools for Xcode.
- Android device with Android Auto installed OR Android Auto's Desktop Head Unit (DHU) bundled with Android Studio.
- A saved commute route (US-21) so the Start Commute quick action is reachable.
- Optional: a fixture hazard within 750 m of the test route so the alert fires.

### Procedure

1. **Pre-ride — quick actions visible**
   - Connect phone to head unit (or launch simulator + DHU).
   - Expect: head unit shows the Tarmoto idle root with "Start Commute" as the only row.
   - Tap "Start Commute" → phone CommuteScreen opens; head unit transitions to the navigation map template.

2. **Active ride — ride status board**
   - Start the commute ride.
   - Expect: head unit displays the four-row status board (Speed, Distance, Duration, Surface) and updates every ~1 s.
   - Expect: the title at the top of the board reads "Commute".

3. **Active ride — hazard alert**
   - Cause the rider to enter the 750 m radius of the fixture hazard (drive past or simulate a location update).
   - Expect: head unit pushes a CPAlertTemplate (iOS) / AlertTemplate (AA) with hazard type + distance + road name + note.
   - Tap "Confirm" → alert dismisses; same hazard re-fires on a future approach.
   - Re-approach hazard, tap "Dismiss" → alert dismisses; hazard does NOT re-fire on subsequent approaches in the same session.

4. **Active ride — voice prompt**
   - Trigger a turn-by-turn voice announcement (drive within 200 m of a maneuver point on the planned route).
   - Expect: voice prompt plays through the head unit's audio system (or paired Bluetooth helmet headset) without double-speak from the phone speaker.

5. **Active ride — quick actions pivot**
   - Expect: quick actions list now shows "Report hazard" + "Stop ride".
   - Tap "Report hazard" → SearchTemplate opens; speak "pothole" → hazard report fires; banner confirms.
   - Tap "Stop ride" → ride store stops; head unit returns to idle root.

6. **Disconnect / reconnect lifecycle**
   - Start a fresh ride, unplug head unit mid-ride, plug back in.
   - Expect: head unit re-mounts the ride status board on the next ride-tick (no blank display, no double-mount flicker).

7. **Background → foreground**
   - Start a ride, background the phone for 2 minutes, foreground.
   - Expect: head unit stays connected throughout; ride state on the bike display matches the foreground HUD.

### Recording

For each step, capture a screen recording of the head unit (CarPlay simulator has built-in recording; AA DHU records via `adb screenrecord`). Attach to the issue thread for posterity.

## Related code

- `apps/mobile/src/services/carplay.ts` — bridge + controllers
- `apps/mobile/src/services/vehicleDisplay.ts` — navigation surface controller
- `apps/mobile/src/hooks/useCarPlayRideMirror.ts` — single-source bridge
- `apps/mobile/src/components/CarPlayRideMirror.tsx` — root leaf wrapper, quick-action wiring
- `apps/mobile/ios/TarmotoApp/TarmotoApp.entitlements` — CarPlay entitlement
- `apps/mobile/ios/TarmotoApp/Info.plist` — UIApplicationSceneManifest
- `apps/mobile/android/app/build.gradle` — `androidx.car.app:app` dependency
- `apps/mobile/android/app/proguard-rules.pro` — AA keep rules
