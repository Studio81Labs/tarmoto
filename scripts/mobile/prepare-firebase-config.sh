#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM="${1:-}"
MODE="${2:-optional}"
TEMP_CONFIG=""

cleanup() {
  if [ -n "$TEMP_CONFIG" ] && [ -f "$TEMP_CONFIG" ]; then
    rm -f "$TEMP_CONFIG"
  fi
}
trap cleanup EXIT

fail_or_skip() {
  local message="$1"
  if [ "$MODE" = "required" ]; then
    echo "error: $message" >&2
    exit 1
  fi
  echo "warning: $message Push notifications will be disabled." >&2
  exit 0
}

decode_config() {
  local encoded="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  TEMP_CONFIG="$(mktemp "${destination}.tmp.XXXXXX")"
  if ! printf '%s' "$encoded" | openssl base64 -d -A -out "$TEMP_CONFIG"; then
    echo "error: Firebase configuration is not valid base64." >&2
    exit 1
  fi
}

case "$PLATFORM" in
  android)
    DESTINATION="$ROOT/apps/mobile/android/app/google-services.json"
    if [ -n "${TARMOTO_FIREBASE_ANDROID_CONFIG_BASE64:-}" ]; then
      decode_config "$TARMOTO_FIREBASE_ANDROID_CONFIG_BASE64" "$DESTINATION"
      CONFIG_TO_VALIDATE="$TEMP_CONFIG"
    elif [ -f "$DESTINATION" ]; then
      CONFIG_TO_VALIDATE="$DESTINATION"
    else
      fail_or_skip "Missing TARMOTO_FIREBASE_ANDROID_CONFIG_BASE64."
    fi
    node -e '
      const fs = require("fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const clients = config.client || [];
      const match = clients.some((client) =>
        client?.client_info?.android_client_info?.package_name === "app.tarmoto"
      );
      if (!match) throw new Error("Firebase Android package must be app.tarmoto");
    ' "$CONFIG_TO_VALIDATE"
    if [ -n "$TEMP_CONFIG" ]; then
      mv "$TEMP_CONFIG" "$DESTINATION"
      TEMP_CONFIG=""
    fi
    ;;
  ios)
    DESTINATION="$ROOT/apps/mobile/ios/TarmotoApp/GoogleService-Info.plist"
    if [ -n "${TARMOTO_FIREBASE_IOS_CONFIG_BASE64:-}" ]; then
      decode_config "$TARMOTO_FIREBASE_IOS_CONFIG_BASE64" "$DESTINATION"
      CONFIG_TO_VALIDATE="$TEMP_CONFIG"
    elif [ -f "$DESTINATION" ]; then
      CONFIG_TO_VALIDATE="$DESTINATION"
    else
      fail_or_skip "Missing TARMOTO_FIREBASE_IOS_CONFIG_BASE64."
    fi
    plutil -lint "$CONFIG_TO_VALIDATE" >/dev/null
    BUNDLE_ID="$(plutil -extract BUNDLE_ID raw -o - "$CONFIG_TO_VALIDATE")"
    if [ "$BUNDLE_ID" != "app.tarmoto" ]; then
      echo "error: Firebase iOS bundle id must be app.tarmoto." >&2
      exit 1
    fi
    if [ -n "$TEMP_CONFIG" ]; then
      mv "$TEMP_CONFIG" "$DESTINATION"
      TEMP_CONFIG=""
    fi
    ;;
  *)
    echo "usage: $0 <android|ios> [optional|required]" >&2
    exit 2
    ;;
esac

echo "Firebase $PLATFORM configuration is ready."
