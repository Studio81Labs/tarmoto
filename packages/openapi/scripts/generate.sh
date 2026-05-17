#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../../../apps/backend"
REPO_ROOT="$SCRIPT_DIR/../../.."

echo "==> Exporting OpenAPI spec from backend..."
(cd "$BACKEND_DIR" && pnpm openapi:export)

echo "==> Regenerating @tarmoto/openapi-client types..."
(cd "$REPO_ROOT" && pnpm --filter @tarmoto/openapi-client generate)

echo "==> Done!"
