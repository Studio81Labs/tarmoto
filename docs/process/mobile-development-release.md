# Mobile development and release

This runbook covers a clean local React Native setup, the PR preview artifacts,
and the credentials still required before shipping to TestFlight or Play
Internal.

## Local prerequisites

- Node.js 24 and pnpm 11
- Android Studio, Android SDK 36, NDK `27.1.12297006`, and Java 17 or newer
- Xcode 26.2 or newer, Ruby 3.3.6, and Bundler 2.5.22 for iOS
- PostgreSQL/Redis plus the backend when testing authenticated or synced flows

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm shared:build
cp apps/mobile/.env.example apps/mobile/.env
pnpm backend:dev
```

For simulators, a blank `TARMOTO_API_URL` selects `localhost:3000` on iOS and
`10.0.2.2:3000` on Android. A physical phone cannot use either address; set the
variable to the development machine's reachable LAN URL, without `/api/v1`.

Launch with `pnpm mobile:ios` or `pnpm mobile:android`. The iOS command checks
the pinned Ruby, installs the bundle and pods, and then runs the app. The
Android command checks Java and the SDK before invoking the React Native CLI.

Firebase files are deliberately ignored by Git. Local UI/map/auth development
works without them; push registration does not. Place the files at:

- `apps/mobile/ios/TarmotoApp/GoogleService-Info.plist`
- `apps/mobile/android/app/google-services.json`

Both Firebase apps must use the identifier `app.tarmoto`. The helper scripts
validate this before a build uses the file.

## Local preflight

Run the JS checks and standalone Android build before opening a PR:

```bash
pnpm --filter @tarmoto/mobile lint
pnpm --filter @tarmoto/mobile typecheck
pnpm --filter @tarmoto/mobile test
cd apps/mobile/android && ./gradlew :app:assembleRelease \
  -PTARMOTO_PREVIEW_SIGNING=true \
  -PreactNativeArchitectures=arm64-v8a,x86_64 --console=plain
```

On macOS, also install pods and compile the release simulator app:

```bash
pnpm --filter @tarmoto/mobile ios:setup
cd apps/mobile/ios
xcodebuild -workspace TarmotoApp.xcworkspace -scheme TarmotoApp \
  -configuration Release -sdk iphonesimulator \
  -destination "generic/platform=iOS Simulator" \
  -onlyUsePackageVersionsFromResolvedFile -skipPackageUpdates \
  CODE_SIGNING_ALLOWED=NO build
```

## PR preview artifacts

`.github/workflows/mobile-ci.yml` builds release-mode, standalone artifacts on
mobile PRs and pushes to `main`:

- `tarmoto-android-preview`: an APK installable with `adb install -r`
- `tarmoto-ios-simulator-preview`: a zipped simulator `.app`, installable after
  unzipping with `xcrun simctl install booted TarmotoApp.app`

They use the production API default, require no signing credentials, omit
Firebase, and expire after seven days. They prove native dependency resolution,
JS bundling, and app compilation; notification delivery, signing, CarPlay, and
Android Auto still need device testing.

## Release configuration

Create the protected GitHub environment `mobile-release` and add the secrets
listed in `apps/mobile/fastlane/README.md`. Encode Firebase files and the
Android keystore as a single base64 value, for example:

```bash
openssl base64 -A -in GoogleService-Info.plist
openssl base64 -A -in google-services.json
openssl base64 -A -in tarmoto-release.keystore
```

The release workflow performs lint, typecheck, and Jest first. It then validates
all platform credentials, materializes the Firebase file, and uses Fastlane to
upload to TestFlight and/or Play Internal. Push a unified `vX.Y.Z+N` tag — the
build number is required (the tag is its source of truth; Fastlane stamps it
into `CFBundleVersion` and `versionCode`), so a store resubmission of the same
version gets its own immutable tag (`v1.2.3+10`, then `v1.2.3+11`). Manual
`workflow_dispatch` rehearsals take a strict `X.Y.Z` version and release notes,
with the run number standing in as the build.

## External release gates

Repository work cannot complete these account-level steps:

- create the iOS and Android Firebase apps and upload APNs credentials to FCM
- create App Store Connect and Play Console app records and service accounts
- configure the encrypted `match` signing repository and Android upload key
- obtain Apple's `com.apple.developer.carplay-maps` entitlement and regenerate
  the provisioning profile after approval
- validate push delivery, background location/sensors, CarPlay, and Android Auto
  on real hardware before production submission

Do not treat simulator previews as store readiness until those gates and the
manual device checklist in [carplay-android-auto.md](./carplay-android-auto.md)
have passed.
