#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE_DIR="$ROOT/apps/mobile"
EXPECTED_RUBY="$(tr -d '[:space:]' < "$MOBILE_DIR/.ruby-version")"

command -v xcodebuild >/dev/null 2>&1 ||
  { echo "error: Xcode is required for iOS builds." >&2; exit 1; }

if command -v rbenv >/dev/null 2>&1; then
  export PATH="$(rbenv root)/shims:$PATH"
fi

ACTUAL_RUBY="$(ruby -e 'print RUBY_VERSION' 2>/dev/null || true)"
if [ "$ACTUAL_RUBY" != "$EXPECTED_RUBY" ]; then
  echo "error: Ruby $EXPECTED_RUBY is required (found ${ACTUAL_RUBY:-none})." >&2
  echo "Install it with: rbenv install $EXPECTED_RUBY" >&2
  exit 1
fi

cd "$MOBILE_DIR"
command -v bundle >/dev/null 2>&1 ||
  { echo "error: Bundler 2.5.22 is required (gem install bundler:2.5.22)." >&2; exit 1; }
ACTUAL_BUNDLER="$(bundle --version | awk '{print $3}')"
if [ "$ACTUAL_BUNDLER" != "2.5.22" ]; then
  echo "error: Bundler 2.5.22 is required (found $ACTUAL_BUNDLER)." >&2
  echo "Install it with: gem install bundler:2.5.22" >&2
  exit 1
fi

bundle check >/dev/null 2>&1 || bundle install
bash "../../scripts/mobile/prepare-firebase-config.sh" ios optional
pnpm exec react-native build-ios --only-pods
