# Runbook

What to do when things break. Today this focuses on **local dev** and the **PoC sensor deploy** — the backend and companion are not yet deployed to production. Expand this doc with production playbooks (AWS ECS, RDS, observability) when those land.

For first-time setup see [../../README.md](../../README.md) and [../../CONTRIBUTING.md](../../CONTRIBUTING.md). For system overview see [../reference/architecture.md](../reference/architecture.md).

## Backend won't build

1. Check the error — most common culprits:
   - `@tarmoto/shared` not built yet → `pnpm build:shared`
   - Node version mismatch → confirm Node 24 (see `.nvmrc`)
   - Stale `node_modules` after big dependency bumps → `pnpm install` or `pnpm clean && pnpm install`
2. If TypeScript complains about missing types from `@tarmoto/shared`, the shared package wasn't rebuilt after a change. Run `pnpm build:shared` and retry.

## Backend won't start / crashes on boot

1. Confirm Docker is running: `docker ps` — expect `postgres` and `redis` containers.
2. If containers aren't up: `pnpm db:up`.
3. If Postgres is up but backend can't connect, check the `TARMOTO_DATABASE_*` env vars or Docker Compose defaults match your backend config.
4. If Redis isn't up or the URL is wrong, WebSocket pub/sub will fail — check the Redis URL in backend config.
5. Tail logs: `pnpm dev:backend` prints NestJS startup errors at the top of the stream.

## Database migration failed

1. Read the TypeORM error — usually names the failing migration and the SQL error.
2. If the migration only partially applied, the `migrations` table may not have recorded it. Verify with:
   ```sql
   SELECT * FROM migrations ORDER BY timestamp DESC LIMIT 5;
   ```
3. Reproduce locally: nuke the dev DB state (`pnpm db:down`, remove the pgdata volume per Docker Compose config, `pnpm db:up`), then re-run `pnpm db:migrate`.
4. Fix the migration (rebuild backend after edits), commit.
5. **Never hand-edit an applied migration** — add a new one. See [typeorm-migrations.md](./typeorm-migrations.md).

## Tests fail only in E2E

1. Confirm the DB is up: `pnpm db:up`.
2. Confirm migrations are current: `pnpm db:migrate`.
3. Check if another test left state behind — E2E setup should drop/recreate the schema between runs. Look for missing `beforeEach` cleanup.
4. If `jest-e2e.json` config drifted, diff against the version on `main`.

## PoC sensor deploy failed (Cloudflare Pages)

1. Open the `deploy-poc.yml` workflow run in GitHub Actions. Read the failing step.
2. Common causes:
   - `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` secret missing or expired.
   - Build failure in `apps/poc-sensor/` — run `pnpm build:poc` locally to reproduce.
   - Path filter didn't trigger — workflow only runs on `apps/poc-sensor/**` changes. Manual trigger via `workflow_dispatch` works for non-code updates.
3. Rollback: Cloudflare Pages dashboard → Deployments → promote a previous successful build to production.

## Docker won't start / port collisions

1. Check what's using your port: `lsof -i :5432` for Postgres, `lsof -i :6379` for Redis.
2. If another local Postgres is running on 5432, either stop it or override the Docker port mapping.
3. `docker system prune` clears old containers/volumes — harmless on a dev machine, but **don't run it on a box that hosts anything you care about**.

## Something pushed secrets to a commit

1. **Rotate the secret immediately.** Assume it's public even if you revert the commit.
2. Revert the commit so the repo history at `main` doesn't advertise the leak.
3. If the commit was pushed to a PR and caught early, force-push a cleaned branch (only your own feature branch — never rewrite `main` history).
4. File an issue so the team knows which secret was rotated and when.

## Mobile build / sensor issues (RN Metro)

1. Common fix for mysterious RN issues: `pnpm dev:mobile -- --reset-cache`.
2. iOS: `cd apps/mobile/ios && pod install` if CocoaPods stale.
3. Android: nuke `~/.gradle/caches` if build errors reference missing dependencies that are clearly declared.
4. If sensors don't emit data in the simulator, that's expected — TF Lite inference requires real device sensor input.

## Incident response checklist (placeholder)

When production deploys land, this section grows. Template for now:

1. **Acknowledge** in the team channel with "investigating" and a timestamp.
2. **Scope** — which app, how many users, what path.
3. **Mitigate first, diagnose later** — roll back if in doubt.
4. **Post-incident** — notes in `docs/reference/incidents/YYYY-MM-DD-<slug>.md` covering symptom, root cause, mitigation, timeline, prevention. Create the `incidents/` folder on first incident.

## What this runbook does NOT yet cover (because we don't deploy them yet)

- Backend production deploy / rollback (no AWS ECS wiring yet)
- RDS Postgres backup/restore
- Secret rotation in production (only local-dev relevance today)
- Companion deployment (not wired)
- Mobile release workflows (App Store / Play Store)

Add sections above as these land.
