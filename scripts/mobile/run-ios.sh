#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/scripts/mobile/setup-ios.sh"
cd "$ROOT/apps/mobile"
exec pnpm exec react-native run-ios "$@"
