#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

java_major() {
  java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p'
}

if ! command -v java >/dev/null 2>&1 || [ "$(java_major)" -lt 17 ]; then
  ANDROID_STUDIO_JDK="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  if [ -d "$ANDROID_STUDIO_JDK" ]; then
    export JAVA_HOME="$ANDROID_STUDIO_JDK"
    export PATH="$JAVA_HOME/bin:$PATH"
  else
    echo "error: Java 17+ is required. Install Android Studio or set JAVA_HOME." >&2
    exit 1
  fi
fi

if [ -z "${ANDROID_HOME:-}" ]; then
  DEFAULT_ANDROID_SDK="$HOME/Library/Android/sdk"
  if [ -d "$DEFAULT_ANDROID_SDK" ]; then
    export ANDROID_HOME="$DEFAULT_ANDROID_SDK"
  else
    echo "error: ANDROID_HOME is not set and the default Android SDK was not found." >&2
    exit 1
  fi
fi

cd "$ROOT/apps/mobile"
bash "../../scripts/mobile/prepare-firebase-config.sh" android optional
exec pnpm exec react-native run-android "$@"
