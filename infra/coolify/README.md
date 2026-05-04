# Tarmoto backend on Hetzner + Coolify

Self-hosted PaaS deploy stack for the backend. Choice rationale: [ADR 0006](../../docs/decisions/0006-deployment-stack-hetzner-coolify.md). Day-2 ops: [`docs/process/runbook.md`](../../docs/process/runbook.md).

```
infra/coolify/
  README.md     This file — operator bootstrap + ongoing ops.
                No YAML/JSON: Coolify is configured via its UI;
                we don't keep a Blueprint here.
```

The `infra/render/` directory is retained for one release cycle as historical reference (see ADR-0006 migration plan, step 10) and will be deleted in a follow-up PR after the first Coolify deploy has served real traffic for ≥24 h.

## VPS

|             |                                           |
| ----------- | ----------------------------------------- |
| Provider    | Hetzner Cloud                             |
| Plan        | CX33 (4 vCPU shared, 8 GB RAM, 80 GB SSD) |
| Region      | Helsinki, FI                              |
| Cost        | €8.46/mo                                  |
| Public IP   | `89.167.80.252`                           |
| Coolify URL | `https://coolify.studio81.cz`             |

Both Tarmoto and Nexcue share this box (separate Coolify projects, isolated containers). When traffic dictates, split Nexcue onto its own VPS.

## One-time bootstrap

Most of this is dashboard work, in order. Steps 1–4 are pure UI; step 5 is GitHub Secrets (CLI); steps 6–7 are operational verification.

### 1. Connect GitHub source

Coolify → **Sources** → **+ New Source** → **GitHub App** → **Create new GitHub App**.

Authorize the App on `Studio81Labs/tarmoto` (and Nexcue too, while you're there). This lets Coolify pull from private repos and receive push webhooks. The GitHub App is the cleanest path; OAuth tokens / SSH deploy keys also work but are more brittle.

### 2. Create the project

Coolify → **Projects** → **+ New Project**:

- **Name**: `tarmoto-prod`
- **Description**: "Tarmoto backend — Hetzner CX33 / Helsinki / supersedes Render per ADR-0006"
- **Default environment**: `production`

### 3. Add resources

#### 3a. PostgreSQL

Project → **+ New Resource** → **Database** → **PostgreSQL** → **Custom Docker image**.

| Setting           | Value                           |
| ----------------- | ------------------------------- |
| Image             | `postgis/postgis:17-3.4-alpine` |
| Name              | `tarmoto-prod-db`               |
| Username          | `tarmoto`                       |
| Database name     | `tarmoto`                       |
| Password          | (Coolify generates)             |
| Persistent volume | yes                             |
| Public access     | **off** (internal-only)         |

PostGIS is initialised by the existing TypeORM migration on first deploy — no manual `CREATE EXTENSION` needed.

If Coolify's "Custom Docker image" field is unavailable, fall back to a **Service** resource (the generic Docker variant) with the same image. Backups still work via Coolify's scheduled `pg_dump` regardless of which path you pick.

#### 3b. Redis

Project → **+ New Resource** → **Database** → **Redis**:

| Setting           | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Image             | `redis:8-alpine` (or Coolify default if it's already 8.x) |
| Name              | `tarmoto-prod-redis`                                      |
| Persistent volume | yes                                                       |
| Public access     | **off**                                                   |

After creation, edit the redis.conf overrides and set:

```
maxmemory-policy noeviction
```

BullMQ requires no eviction so jobs aren't dropped under memory pressure.

#### 3c. Backend Application

Project → **+ New Resource** → **Application** → **Private Repository (with GitHub App)**:

| Setting             | Value                     |
| ------------------- | ------------------------- |
| Repository          | `Studio81Labs/tarmoto`    |
| Branch              | `main`                    |
| Build pack          | Dockerfile                |
| Dockerfile          | `apps/backend/Dockerfile` |
| Build context       | `.` (repo root)           |
| Port                | `3000`                    |
| Health check path   | `/api/v1/healthz`         |
| Auto-deploy on push | **on**                    |

**Don't deploy yet** — env vars + domain come next.

### 4. Application env vars

Application → **Environment Variables**. Mirror the set declared in the now-deprecated [`infra/render/render.yaml`](../render/render.yaml), substituting Coolify's internal DNS for DB and Redis hosts.

#### Plain values (safe to commit / share)

```
TARMOTO_NODE_ENV=production
TARMOTO_PORT=3000
TARMOTO_TRUST_PROXY_HOPS=1
TARMOTO_COMPANION_URL=https://app.tarmoto.app
TARMOTO_STORAGE_DRIVER=s3
TARMOTO_S3_REGION=auto
TARMOTO_S3_FORCE_PATH_STYLE=false
```

#### From Coolify resources

Coolify exposes managed-resource hostnames in the UI. They look like `tarmoto-prod-db-postgresql-<short-uuid>` and `tarmoto-prod-redis-redis-<short-uuid>`. Use the values Coolify shows you:

```
TARMOTO_DATABASE_HOST=<from Postgres resource page>
TARMOTO_DATABASE_PORT=5432
TARMOTO_DATABASE_NAME=tarmoto
TARMOTO_DATABASE_USER=tarmoto
TARMOTO_DATABASE_PASSWORD=<from Postgres resource page>
TARMOTO_REDIS_HOST=<from Redis resource page>
TARMOTO_REDIS_PORT=6379
```

#### Operator secrets (filled from external dashboards)

```
TARMOTO_JWT_SECRET=<generate one — `openssl rand -base64 32`>
TARMOTO_S3_BUCKET=tarmoto-prod-uploads
TARMOTO_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
TARMOTO_S3_ACCESS_KEY_ID=<R2 token>
TARMOTO_S3_SECRET_ACCESS_KEY=<R2 token>
TARMOTO_S3_PUBLIC_URL_BASE=https://uploads.tarmoto.app
TARMOTO_STRIPE_SECRET_KEY=
TARMOTO_STRIPE_WEBHOOK_SECRET=
TARMOTO_STRIPE_PREMIUM_PRICE_ID=
TARMOTO_STRIPE_PRO_PRICE_ID=
TARMOTO_OWM_API_KEY=
```

#### Optional (push)

```
TARMOTO_FCM_PROJECT_ID=
TARMOTO_FCM_CLIENT_EMAIL=
TARMOTO_FCM_PRIVATE_KEY=
TARMOTO_APN_KEY=
TARMOTO_APN_KEY_ID=
TARMOTO_APN_TEAM_ID=
TARMOTO_APN_TOPIC=
TARMOTO_APN_PRODUCTION=true
```

Push providers degrade gracefully when unset — the backend logs payloads instead of dispatching.

### 5. GitHub Secrets

CI's deploy workflow needs three values. Add them via `gh` from your terminal so they never land in chat:

```bash
gh secret set COOLIFY_API_TOKEN          --repo Studio81Labs/tarmoto
gh secret set COOLIFY_DEPLOY_WEBHOOK_URL --repo Studio81Labs/tarmoto
gh secret set COOLIFY_APPLICATION_UUID   --repo Studio81Labs/tarmoto

gh variable set BACKEND_URL_PROD --repo Studio81Labs/tarmoto --body "https://api.tarmoto.app"
```

The webhook URL and application UUID are visible on the Application page in Coolify (**Webhooks** tab and the URL bar respectively). The API token is the rotated value from Coolify → **Keys & Tokens → API Tokens**.

### 6. Domain + TLS

- Application → **Domains** → add `api.tarmoto.app`. Coolify configures Caddy + Let's Encrypt automatically.
- Cloudflare DNS → **A** record `api.tarmoto.app` → `89.167.80.252`. Either **DNS-only (gray cloud)** or **Proxied (orange cloud)** works — Caddy issues the cert via direct port 80/443 challenge in either case.

### 7. First deploy

Application → **Deploy**. Watch logs. After ~2 min the container should be live and `https://api.tarmoto.app/api/v1/healthz` returns 200. Run the smoke script locally to confirm:

```bash
scripts/smoke/smoke.sh https://api.tarmoto.app
```

## Backups

Coolify schedules `pg_dump` to S3-compatible targets. Configure on the Postgres resource page → **Backups**.

| Setting    | Value                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------- |
| Frequency  | daily, 03:00 UTC (off-peak EU)                                                               |
| Retention  | 14 days                                                                                      |
| Target     | Cloudflare R2 bucket `tarmoto-prod-backups` (separate from the app's `tarmoto-prod-uploads`) |
| Endpoint   | `https://<account-id>.r2.cloudflarestorage.com`                                              |
| Access key | dedicated R2 token, scoped to `tarmoto-prod-backups` write-only                              |

**Restore drill** is documented in [`docs/process/runbook.md`](../../docs/process/runbook.md). Run it once before serving prod traffic and quarterly thereafter.

## Cost (rough, /month)

| Item                                               | Cost                                     |
| -------------------------------------------------- | ---------------------------------------- |
| Hetzner CX33 (4 vCPU / 8 GB / 80 GB)               | €8.46                                    |
| Hetzner snapshot (~1 GB volume × €0.0119)          | ~€0.02                                   |
| Cloudflare R2 storage (uploads + tiles + backups)  | ~€1–3 (volume-dependent, no egress fees) |
| Cloudflare DNS / Workers (companion) / Pages (PoC) | €0 (free tier)                           |
| **Total**                                          | **~€10–12**                              |

## Day-2 ops

- **Coolify upgrades**: SSH to VPS, run `coolify update`. Monthly. See [Coolify update docs](https://coolify.io/docs/knowledge-base/server/update).
- **OS patches**: Hetzner auto-applies kernel security updates. Reboot scheduling is an operator task — verify in `unattended-upgrades` config that `Unattended-Upgrade::Automatic-Reboot "false"` so we control reboot timing.
- **Disk usage**: monitor via Coolify dashboard or `df -h` on the VPS. 80 GB is generous, but Postgres + R2 backup staging + Docker layers can grow.
- **Memory pressure**: Coolify shows per-container RAM. If sustained > 80% on the box, that's the signal to split Nexcue onto its own CX23.
- **Logs**: per-application via Coolify UI; central aggregation deferred (see ADR-0006 "no managed observability" consequence).

## Rollback

From the Coolify dashboard: **Application → Deployments → previous successful deployment → Redeploy**. Or via API in CI (see [`backend-deploy.yml`](../../.github/workflows/backend-deploy.yml)'s rollback step).

Coolify does not snapshot DB state on deploy, so a rollback that reverts a migration must be paired with a manual `typeorm migration:revert` (documented in the runbook).

## Decommissioning Render

Once the first Coolify deploy has served real traffic for ≥24 h:

1. Cancel the Render Web Service (`tarmoto-prod-backend`).
2. Cancel the Render Postgres (`tarmoto-prod-db`).
3. Cancel the Render Key Value (`tarmoto-prod-redis`).
4. Remove `RENDER_API_KEY`, `RENDER_SERVICE_ID_PROD` GitHub secrets.
5. Open a follow-up PR to delete `infra/render/`. ADR-0005 stays as historical record.
