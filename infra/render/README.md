# Tarmoto backend on Render

Render Blueprint for the backend stack. Choice rationale: [ADR 0005](../../docs/decisions/0005-deployment-stack-render.md). Day-2 ops: [`docs/process/runbook.md`](../../docs/process/runbook.md).

```
infra/render/
  render.yaml   Blueprint: managed Postgres, Key Value (Redis), and
                the backend Web Service. Staging only — prod is
                added when the app is closer to a real launch.
  README.md     This file.
```

## One-time bootstrap

1. **Create a Render account** for the org (or use the existing one if Tarmoto already shares a workspace with the sibling project).
2. **Connect the GitHub repo** to Render with read access.
3. **Create a new Blueprint** in the Render dashboard, pointing it at `infra/render/render.yaml`.
4. On first apply, Render provisions the database + Key Value service + the backend Web Service. The Web Service will fail its first build until the `sync: false` env vars (R2 credentials, Stripe keys, OWM key) are populated — that's intentional, not a bug. Fill them in the dashboard and click **Manual Deploy → Deploy latest commit**.
5. Add the staging custom domain (e.g. `api.staging.tarmoto.app`) to the Web Service. Render issues a TLS cert via Let's Encrypt; point the Cloudflare DNS record (`CNAME` → `tarmoto-staging-backend.onrender.com`) at it.

## What the Blueprint creates

- **`tarmoto-staging-db`** — Render Postgres, plan `standard`, region `frankfurt`, PG16. PostGIS is enabled by the existing TypeORM migration on first deploy.
- **`tarmoto-staging-redis`** — Render Key Value (Redis-compatible), plan `starter`, `noeviction` (BullMQ requirement).
- **`tarmoto-staging-backend`** — Web Service running `apps/backend/Dockerfile`. Auto-deploys on push to `main`. Runs `typeorm migration:run` as `preDeployCommand`; if migrations fail, the previous version keeps serving traffic.

## Cost (rough, /month)

| Service           | Plan                      | Cost     |
| ----------------- | ------------------------- | -------- |
| Web Service       | Standard (0.5 CPU / 2 GB) | ~$25     |
| Postgres          | Standard                  | ~$19     |
| Key Value         | Starter                   | ~$10     |
| **Total per env** |                           | **~$55** |

R2 (object storage) and Cloudflare DNS / Workers (companion, PoC) bill separately on the Cloudflare side; R2 has no egress fees so the storage line is dominated by stored bytes.

## Env vars populated by the operator

These are declared `sync: false` in [`render.yaml`](./render.yaml) — the Web Service won't successfully start until they're filled in the Render dashboard:

| Var                               | Source                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `TARMOTO_S3_BUCKET`               | R2 bucket name (e.g. `tarmoto-staging-uploads`)                           |
| `TARMOTO_S3_ENDPOINT`             | `https://<account-id>.r2.cloudflarestorage.com`                           |
| `TARMOTO_S3_ACCESS_KEY_ID`        | R2 API token                                                              |
| `TARMOTO_S3_SECRET_ACCESS_KEY`    | R2 API token                                                              |
| `TARMOTO_S3_PUBLIC_URL_BASE`      | Custom R2 domain (e.g. `https://uploads.staging.tarmoto.app`)             |
| `TARMOTO_STRIPE_SECRET_KEY`       | Stripe                                                                    |
| `TARMOTO_STRIPE_WEBHOOK_SECRET`   | Stripe                                                                    |
| `TARMOTO_STRIPE_PREMIUM_PRICE_ID` | Stripe                                                                    |
| `TARMOTO_STRIPE_PRO_PRICE_ID`     | Stripe                                                                    |
| `TARMOTO_OWM_API_KEY`             | OpenWeatherMap                                                            |
| `TARMOTO_FCM_*`                   | Firebase service account (optional — push disables gracefully without it) |
| `TARMOTO_APN_*`                   | Apple push key (optional — same)                                          |

## Adding production later

Duplicate the staging service block in [`render.yaml`](./render.yaml) with `prod` substituted into names and:

- `autoDeploy: false` — prod deploys are driven by tag pushes (`backend-v*`) via [`backend-deploy.yml`](../../.github/workflows/backend-deploy.yml) calling Render's deploy hook.
- A larger Postgres plan (`pro`) for headroom and PITR.
- Region `frankfurt` to match staging unless latency data justifies otherwise.

## Rollback

From the Render dashboard: **Web Service → Deploys → previous successful deploy → Rollback**. Or via the Render API in CI (see `backend-deploy.yml`'s rollback step).

Render does not snapshot DB state on deploy, so a rollback that reverts a migration must be paired with a manual `typeorm migration:revert` (documented in [`docs/process/runbook.md`](../../docs/process/runbook.md)).
