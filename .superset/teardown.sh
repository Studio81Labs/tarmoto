#!/usr/bin/env bash
# Superset workspace teardown for Tarmoto.
# Runs when a workspace (git worktree) is deleted.
#
# Stops the local Postgres + Redis containers started during setup. The
# data volume is preserved (no `-v`) so re-creating a workspace keeps
# your data. The compose project is shared across all worktrees, so this
# stops the services for any other active Tarmoto workspaces too; they
# can restart them with `pnpm db:up`.
set -euo pipefail

COMPOSE="docker compose -f infra/docker/docker-compose.yml"

echo "Stopping Postgres + Redis..."
$COMPOSE down
printf '  \033[0;32m✔\033[0m %s\n' "Docker Compose down (data volume preserved)"
