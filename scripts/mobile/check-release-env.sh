#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"

case "$PLATFORM" in
  ios)
    REQUIRED=(
      TARMOTO_FIREBASE_IOS_CONFIG_BASE64
      APP_STORE_CONNECT_API_KEY_ID
      APP_STORE_CONNECT_API_ISSUER_ID
      APP_STORE_CONNECT_API_KEY_CONTENT
      MATCH_GIT_URL
      MATCH_GIT_BASIC_AUTHORIZATION
      MATCH_PASSWORD
      FASTLANE_APPLE_ID
      FASTLANE_TEAM_ID
      FASTLANE_ITC_TEAM_ID
      IOS_KEYCHAIN_PASSWORD
    )
    ;;
  android)
    REQUIRED=(
      TARMOTO_FIREBASE_ANDROID_CONFIG_BASE64
      ANDROID_KEYSTORE_BASE64
      ANDROID_KEYSTORE_PASSWORD
      ANDROID_KEY_ALIAS
      ANDROID_KEY_PASSWORD
      PLAY_STORE_JSON_KEY
    )
    ;;
  *)
    echo "usage: $0 <android|ios>" >&2
    exit 2
    ;;
esac

missing=()
for name in "${REQUIRED[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'error: missing required %s release secrets:\n' "$PLATFORM" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "All required $PLATFORM release secrets are configured."
