#!/usr/bin/env bash
# Superset workspace setup for Tarmoto.
# Runs every time a new workspace (git worktree) is created.
#
# Gets the worktree from "freshly created" to "ready to run":
#   1. install dependencies
#   2. provision per-app .env files
#   3. start the shared local Postgres + Redis
#   4. wait for Postgres to be healthy
#   5. build @tarmoto/shared and apply TypeORM migrations
set -euo pipefail

ok()   { printf '  \033[0;32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$1"; }

COMPOSE="docker compose -f infra/docker/docker-compose.yml"

# ── 1. Install dependencies ─────────────────────────────────────────
echo "Installing dependencies..."
pnpm install
ok "pnpm install"

# ── 2. Per-app env files ────────────────────────────────────────────
# Prefer the real .env from the root checkout so local secrets / DB
# config carry over to the worktree; fall back to the committed
# example otherwise.
echo "Setting up per-app .env files..."
for app in backend companion; do
  TARGET="apps/${app}/.env"
  EXAMPLE="apps/${app}/.env.example"
  if [ -f "$TARGET" ]; then
    ok "apps/${app}/.env already exists"
  elif [ -n "${SUPERSET_ROOT_PATH:-}" ] && [ -f "$SUPERSET_ROOT_PATH/$TARGET" ]; then
    cp "$SUPERSET_ROOT_PATH/$TARGET" "$TARGET"
    ok "apps/${app}/.env copied from root checkout"
  elif [ -f "$EXAMPLE" ]; then
    cp "$EXAMPLE" "$TARGET"
    ok "apps/${app}/.env created from .env.example"
  else
    warn "no apps/${app}/.env source found — skipping"
  fi
done

# ── 3. Start Postgres + Redis ───────────────────────────────────────
# The compose project name is fixed ("tarmoto-dev"), so every worktree
# shares one Postgres container + data volume.
echo "Starting Postgres + Redis..."
$COMPOSE up -d
ok "Docker Compose up"

# ── 4. Wait for Postgres to be healthy ──────────────────────────────
printf '  Waiting for Postgres to be healthy'
RETRIES=30
until $COMPOSE exec -T postgres pg_isready -U tarmoto >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    printf '\n'
    warn "Postgres did not become healthy in time"
    exit 1
  fi
  sleep 1
  printf '.'
done
printf '\n'
ok "Postgres is ready"

# ── 5. Build shared + run migrations ────────────────────────────────
# @tarmoto/shared has no install-time build and the backend resolves
# it from dist; TypeORM also reads the compiled data-source, so build
# shared first, then migrate (db:migrate builds the backend itself).
echo "Building @tarmoto/shared and applying migrations..."
pnpm shared:build
ok "shared built"
pnpm db:migrate
ok "TypeORM migrations applied"

echo ""
ok "Workspace ready — start the dev servers with the Run button (pnpm dev)."
