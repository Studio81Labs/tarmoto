#!/usr/bin/env bash
# Tarmoto — full dev environment bootstrap.
# Gets a developer from clone to running backend in one command: pnpm bootstrap
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Colours ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Colour

ok()   { echo -e "  ${GREEN}✔${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✖${NC} $1"; exit 1; }

# ── 1. Check prerequisites ──────────────────────────────────────────
echo ""
echo "Checking prerequisites..."

command -v node   >/dev/null 2>&1 || fail "node is not installed (need >= 24)"
command -v pnpm   >/dev/null 2>&1 || fail "pnpm is not installed (need >= 10)"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js >= 24 required (found $(node -v))"
ok "node $(node -v)"
ok "pnpm $(pnpm -v)"
ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ── 2. Install dependencies ─────────────────────────────────────────
echo ""
echo "Installing dependencies..."
pnpm install
ok "pnpm install"

# ── 3. Copy .env.example → .env (per app) ──────────────────────────
echo ""
echo "Setting up environment files..."

for app in backend mobile companion ingest; do
  EXAMPLE="apps/${app}/.env.example"
  TARGET="apps/${app}/.env"
  if [ -f "$EXAMPLE" ]; then
    if [ ! -f "$TARGET" ]; then
      cp "$EXAMPLE" "$TARGET"
      ok "$TARGET created from .env.example"
    else
      ok "$TARGET already exists"
    fi
  fi
done

# ── 4. Start Postgres + Redis via Docker Compose ────────────────────
echo ""
echo "Starting Postgres + Redis..."
docker compose -f infra/docker/docker-compose.yml up -d
ok "Docker Compose up"

# ── 5. Wait for Postgres to be healthy ──────────────────────────────
echo -n "  Waiting for Postgres to be healthy..."
RETRIES=30
until docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_isready -U tarmoto >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo ""
    fail "Postgres did not become healthy in time"
  fi
  sleep 1
  echo -n "."
done
echo ""
ok "Postgres is ready"

# ── 6. Build shared + backend (TypeORM reads compiled data-source) ──
echo ""
echo "Building shared + backend..."
pnpm shared:build
ok "shared built"
pnpm ingest:build
ok "ingest built"
pnpm poi-db:build
ok "poi-db built"
pnpm backend:build
ok "backend built"

# ── 7. Run TypeORM migrations ───────────────────────────────────────
echo ""
echo "Running database migrations..."
pnpm db:migrate
ok "TypeORM migrations applied"
# The POI database is a SEPARATE Postgres (ADR-0007) whose schema is owned by
# apps/ingest (migrationsRun) — the backend now reads it with migrationsRun:false.
# Bootstrap doesn't start apps/ingest, so apply the POI migrations here or a fresh
# dev DB has no pois/poi_import_regions/poi_import_runs tables and POI reads 500.
# The POI DB is a DISTINCT container (poi-postgres, host port 5434); the readiness
# loop above only waited for the core Postgres, so wait for poi-postgres too — a
# fresh empty volume can still be initializing when the core DB is already up, and
# db:migrate:poi connecting too early aborts bootstrap with a connection failure.
echo -n "  Waiting for the POI Postgres to be healthy..."
RETRIES=30
until docker compose -f infra/docker/docker-compose.yml exec -T poi-postgres pg_isready -U "${TARMOTO_POI_DATABASE_USER:-tarmoto}" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo ""
    fail "POI Postgres did not become healthy in time"
  fi
  sleep 1
  echo -n "."
done
echo ""
ok "POI Postgres is ready"
pnpm db:migrate:poi
ok "POI migrations applied"

# ── 8. Success summary ──────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Tarmoto dev environment is ready!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Next steps:"
echo ""
echo "    # Start the backend (watch mode)"
echo "    pnpm backend:dev"
echo ""
echo "    # Run the mobile app"
echo "    pnpm mobile:dev   # then: pnpm mobile:ios  or  pnpm mobile:android"
echo ""
echo "    # Run the web companion"
echo "    pnpm companion:dev"
echo ""
echo "    # Regenerate the OpenAPI client (after API changes)"
echo "    pnpm openapi:gen"
echo ""
