# Fastlane

Release tooling for the Tarmoto mobile app. Two lanes — `beta_ios`
(TestFlight) and `beta_android` (Play Internal track) — are wired up
in [Fastfile](./Fastfile). Versioning is driven by the git tag
`mobile-vX.Y.Z` and the GitHub run number; nothing is bumped in
source. The workflow that drives them lives at
[.github/workflows/mobile-release.yml](../../../.github/workflows/mobile-release.yml).

## One-time setup

### iOS

1. Create an App Store Connect API key (Users and Access → Keys), download the `.p8`.
2. Set up `match` against an encrypted git repo:
   ```bash
   bundle exec fastlane match init
   bundle exec fastlane match appstore --app_identifier app.tarmoto
   ```
   Push the resulting profiles to the match repo. Use a deploy key
   scoped read-only to that repo for CI.
3. Configure repo secrets (see "Required CI secrets" below).

### Android

1. Generate a release keystore (one-time, store securely):
   ```bash
   keytool -genkey -v -keystore tarmoto-release.keystore -alias tarmoto \
           -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Create a Play Console service account (Setup → API access) with
   "Release manager" permissions. Download the JSON key.
3. Configure repo secrets.

## Required CI secrets

Set under **Settings → Secrets and variables → Actions** for the
`mobile-release` environment.

| Secret                              | Used by | Notes                                           |
| ----------------------------------- | ------- | ----------------------------------------------- |
| `APP_STORE_CONNECT_API_KEY_ID`      | iOS     | The 10-char Key ID.                             |
| `APP_STORE_CONNECT_API_ISSUER_ID`   | iOS     | UUID issuer id from ASC.                        |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | iOS     | Full `.p8` body, including `BEGIN PRIVATE KEY`. |
| `MATCH_GIT_BASIC_AUTHORIZATION`     | iOS     | `base64(user:token)` for the match repo.        |
| `MATCH_PASSWORD`                    | iOS     | Symmetric password for the match repo.          |
| `FASTLANE_APPLE_ID`                 | iOS     | Apple ID email.                                 |
| `FASTLANE_TEAM_ID`                  | iOS     | Apple Developer team id (10 chars).             |
| `FASTLANE_ITC_TEAM_ID`              | iOS     | App Store Connect team id (numeric).            |
| `IOS_KEYCHAIN_PASSWORD`             | iOS     | Random per-run keychain password.               |
| `ANDROID_KEYSTORE_BASE64`           | Android | Base64'd keystore — workflow writes it to disk. |
| `ANDROID_KEYSTORE_PASSWORD`         | Android | Keystore password.                              |
| `ANDROID_KEY_ALIAS`                 | Android | Key alias inside the store (e.g. `tarmoto`).    |
| `ANDROID_KEY_PASSWORD`              | Android | Key password.                                   |
| `PLAY_STORE_JSON_KEY`               | Android | Full service-account JSON, single line.         |

## Local dry-run

Both lanes accept `--env` overrides. To test the iOS lane against a
sandbox without uploading:

```bash
cd apps/mobile
bundle install
bundle exec fastlane beta_ios version:1.0.0 build:1 notes:"local dry run"
```

For the Android lane, point `ANDROID_KEYSTORE_PATH` at a local debug
keystore for a dry run, but **don't upload** with debug signing —
Play Console rejects it.
