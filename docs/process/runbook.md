# Tarmoto operations runbook

Day-2 procedures for running Tarmoto on Hetzner CX33 + Coolify + Cloudflare. Architectural rationale lives in [`ADR-0006`](../decisions/0006-deployment-stack-hetzner-coolify.md).

## Deploys

Two environments per service. The split is enforced in two places that **must** stay in sync — drift between them is what allows production to deploy on a stray `main` merge.

|                                    | Staging                   | Production                              |
| ---------------------------------- | ------------------------- | --------------------------------------- |
| Trigger                            | push to `main`            | push tag `v*`                           |
| Coolify GitHub App watching `main` | Yes                       | Yes (read-only)                         |
| Coolify "Auto Deploy" toggle       | **ON**                    | **OFF**                                 |
| CI fires deploy webhook            | No (Coolify auto-deploys) | Yes (`COOLIFY_PROD_DEPLOY_WEBHOOK_URL`) |
| Healthcheck + smoke target         | `api-staging.tarmoto.app` | `api.tarmoto.app`                       |

Both Coolify applications keep the GitHub source connected so manual redeploys from the Coolify UI work in either direction. The **only** difference is the Auto Deploy toggle on the production app, set in `Application → Advanced Settings → Deployment → Auto Deploy = OFF`.

### Releasing to production

1. Verify `main` is healthy on staging — the Backend Deploy run for the head of `main` should be green and `api-staging.tarmoto.app/api/v1/healthz` should return 200.
2. Cut a tag from `main`:
   ```bash
   git fetch origin
   git tag -a v0.X.Y origin/main -m "Release v0.X.Y"
   git push origin v0.X.Y
   ```
3. Tag push triggers `backend-deploy.yml` with `IS_TAG=true` → fires `COOLIFY_PROD_DEPLOY_WEBHOOK_URL` → polls `api.tarmoto.app/api/v1/healthz` → runs `scripts/smoke/smoke.sh` → rolls back on failure via the Coolify API.
4. Mobile + companion follow the same tag-based pattern (`mobile-release.yml` reads `mobile-vX.Y.Z`; `companion-deploy.yml` resolves `production` worker on `v*`).

### Verifying the split is intact

After any Coolify upgrade, app re-creation, or restore from backup, walk through this checklist before merging the next PR to `main`:

1. Coolify UI → Production application → **Advanced Settings → Deployment**.
2. Confirm **Auto Deploy = OFF** for production.
3. Confirm **Auto Deploy = ON** for staging.
4. Push a no-op commit to a feature branch, merge to `main`, watch GitHub Actions:
   - **Backend Deploy** workflow fires.
   - The "Resolve environment" step shows `IS_TAG=false` → `ENV_NAME=staging`.
   - The "Trigger Coolify deploy (production only)" step is **skipped**.
   - "Wait for deploy to go live" + "Smoke test" both target `BACKEND_URL_STAGING`.
5. Production application's deploy history in Coolify shows **no** new deploy from this main push.
6. Tag the same commit, push the tag, confirm production deploys and the smoke runs against `api.tarmoto.app`.

If step 5 fails (production redeployed on a main push), the Auto Deploy toggle has flipped back ON — re-disable it and audit why (Coolify upgrade reset config, manual change, etc.).

### Rollback (production)

The CI auto-rolls back on smoke failure. To force a manual rollback:

1. Coolify UI → Production application → **Deployments**.
2. Find the last known-good deployment (one before the bad one).
3. Click **Redeploy** on that row.
4. Watch the deploy logs until traffic switches; verify `api.tarmoto.app/api/v1/healthz` returns 200.
5. Run `scripts/smoke/smoke.sh https://api.tarmoto.app` locally as a final check.

### Required GitHub Secrets / Variables

Per `.github/workflows/backend-deploy.yml`:

**Secrets:**

- `COOLIFY_API_TOKEN` — for poll + rollback (Coolify → Keys & Tokens)
- `COOLIFY_PROD_DEPLOY_WEBHOOK_URL` — production deploy webhook
- `COOLIFY_STAGING_DEPLOY_WEBHOOK_URL` — staging deploy webhook (used by `workflow_dispatch`)

**Variables:**

- `BACKEND_URL_PROD`, `BACKEND_URL_STAGING`
- `COOLIFY_PROD_APPLICATION_UUID`, `COOLIFY_STAGING_APPLICATION_UUID`
