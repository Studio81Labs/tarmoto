#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../../../apps/backend"

echo "==> Exporting OpenAPI spec from backend..."
(cd "$BACKEND_DIR" && pnpm openapi:export)

echo "==> Generating TypeScript types..."
cd "$SCRIPT_DIR/.."
pnpm generate:types

echo "==> Done!"
