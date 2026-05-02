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

## Background jobs aren't running / queue depth is climbing

1. Hit `GET /jobs/health` and check `workers_enabled`. If `false`, this process is configured as the producer-only side of a split deployment — workers must be running elsewhere.
2. If `workers_enabled: true`, look at per-queue counters:
   - `waiting` rising while `active` stays at 0: the worker can't pick up jobs. Check Redis connectivity (`TARMOTO_REDIS_HOST`/`PORT`) and whether the process is starved (CPU pegged, GC pauses).
   - `failed` climbing: read the `lastFailure` summary on the queue's entry — it includes `failed_reason` and `attempts_made`. After 5 attempts the job stops retrying.
3. Recurring schedules are reconciled at boot. If the hourly hazard cleanup or daily account-deletion sweep stops firing, restart the worker process — the scheduler upserts repeatables on `onApplicationBootstrap`.
4. To run a one-off recompute (e.g. fun zones) without waiting for the weekly slot, the CLI script `pnpm cluster:fun-zones` still works and is independent of the queue.

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

## Mobile permission and manifest issues

After any change to `apps/mobile/ios/TarmotoApp/Info.plist` or
`apps/mobile/android/app/src/main/AndroidManifest.xml`:

1. Reinstall the app on the device — granted permissions are scoped to
   the install on Android, and iOS caches the plist purpose strings
   shown in Settings → Privacy.
2. iOS: `cd apps/mobile/ios && pod install` after touching the plist
   and re-run `pnpm ios`.
3. Android: `cd apps/mobile/android && ./gradlew clean` then `pnpm
android` to drop the merged-manifest cache.

### "Ride won't start, HUD stuck at 0 km/h" (Android)

The screen now gates ride start on `ACCESS_FINE_LOCATION`. If the
permission was denied with "Don't ask again", the rationale Alert
opens settings via `Linking.openSettings()`. If the dialog shows but
nothing happens on tap, the device's app-info screen is missing —
usually a custom OEM build that changes the settings deep-link target.
Manually navigate Settings → Apps → Tarmoto → Permissions → Location.

### "TTS announcements stop the moment the screen locks" (iOS)

iOS kills audio playback in apps that don't declare the `audio`
background mode. Confirm `UIBackgroundModes` in Info.plist contains
`audio` (and `location` for the GPS watch). On a fresh checkout that
predates issue #280 this was missing — incremental builds keep the old
plist baked into the IPA, so reinstall the app after pulling.

### "Push permission prompt has no Tarmoto explainer" (Android)

The pre-prompt rationale Alert ships in `services/permissions.ts`. If
a rider doesn't see it, the most common cause is a build that
predates issue #280 still running on the device — uninstall and
reinstall the app.

## Proxy & throttling

`ThrottlerGuard` keys rate-limit buckets off the client IP it gets from
`req.ip`. Behind any reverse proxy (CDN, load balancer, ingress), `req.ip`
resolves to the proxy unless Express is told how many upstream hops to trust.
Two failure modes to avoid:

- **No trust set** → every client behind the proxy shares one bucket. One
  noisy caller exhausts the limit for every legitimate user.
- **`trust proxy: true`** → any upstream can spoof `X-Forwarded-For` and bypass
  throttling entirely. **Never use this.**

Configure the real hop count via `TARMOTO_TRUST_PROXY_HOPS`:

| Deployment                      | Value          | Reason                             |
| ------------------------------- | -------------- | ---------------------------------- |
| Local dev, app exposed directly | unset (or `0`) | No proxies in front.               |
| One CDN / LB in front           | `1`            | Walk X-Forwarded-For back one hop. |
| CDN → LB → app (two tiers)      | `2`            | Two trusted hops.                  |

Set the value to match the **actual** topology at the time of deploy. Every
time a hop is added or removed (new CDN, extra ingress, sidecar), update the
env var and redeploy — getting this wrong silently breaks throttling in one of
the two failure modes above.

Test locally with:

```bash
TARMOTO_TRUST_PROXY_HOPS=1 pnpm dev:backend
curl -H "X-Forwarded-For: 1.2.3.4" -sS http://localhost:3000/api/v1/...
```

## Crash-alert SMS / voice dispatch (US-12)

The `POST /safety/crash-alert` endpoint dispatches SMS (and a voice call when
`severity=high`) via the configured `CrashAlertNotifier`. The default
implementation is `TwilioCrashAlertNotifier`. Without credentials the notifier
silently falls back to log-only mode so dev and CI continue to work.

### Required env vars (staging)

| Variable                         | Required | Notes                                      |
| -------------------------------- | -------- | ------------------------------------------ |
| `TARMOTO_TWILIO_ACCOUNT_SID`     | yes      | Found in the Twilio console.               |
| `TARMOTO_TWILIO_AUTH_TOKEN`      | yes      | Treat as a secret. Store in 1Password.     |
| `TARMOTO_TWILIO_FROM_NUMBER`     | yes      | E.164, must be Twilio-owned & SMS-enabled. |
| `TARMOTO_TWILIO_VOICE_TWIML_URL` | no       | If unset, voice calls use inline TwiML.    |

If any of the three required vars are missing the backend logs:

```
Twilio crash-alert notifier disabled — set TARMOTO_TWILIO_ACCOUNT_SID, ...
```

…on boot, and every dispatch records `channel=log` instead of `sms`/`voice`.

### Smoke test on staging

1. Add yourself as an emergency contact under your test account
   (`POST /users/me/contacts` with `is_emergency: true`).
2. Acquire a JWT for that account.
3. Trigger an alert — the response includes a per-contact `status`. A real
   send shows `channel: "sms"` and a non-null `provider_message_id` (Twilio
   `SM…` SID):

   ```bash
   curl -sS -X POST https://staging.tarmoto.app/api/v1/safety/crash-alert \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{
       "lat": 49.1,
       "lng": 16.75,
       "speed_at_impact": 72,
       "severity": "high",
       "alert_id": "00000000-0000-4000-8000-000000000001"
     }'
   ```

4. Confirm the SMS (and voice call when `severity=high`) lands on the
   contact's phone. Cross-check against the Twilio console under
   _Monitor → Logs → Messages / Calls_ using the returned SID.
5. Re-send the same `alert_id` — the response should be `idempotent_replay:
true` and **no second SMS** should arrive. Twilio also dedupes via
   `I-Twilio-Idempotency-Token` as a second line of defence.
6. Inspect the audit row:

   ```sql
   SELECT id, severity, contacts_notified, contacts_total, contact_results
   FROM crash_alerts
   ORDER BY created_at DESC LIMIT 5;
   ```

### Common failures

- **`Twilio API error: Authenticate`** — `TARMOTO_TWILIO_AUTH_TOKEN` wrong
  or rotated. Update the secret and redeploy.
- **`channel=log` in response despite secrets being set** — env vars set in
  the wrong scope (e.g. only on the worker, not the API). Check the boot
  log for the disabled-notifier warning.
- **Throttled (HTTP 429) when re-testing rapidly** — the endpoint is capped
  at 5 req/min/IP. Wait or use a different IP.

## Transactional email

The backend ships transactional mail (verification, password reset,
password changed, subscription confirmations, account-deletion notices,
data-export delivery) through a small pluggable pipeline:

- `EmailModule` selects an `EmailProvider` at boot from
  `TARMOTO_EMAIL_PROVIDER` (`log` or `resend`).
- `EmailService` renders typed templates and dispatches them; if the
  configured provider throws, it falls back to logging the rendered
  message so on-call always has the content.
- All sends are best-effort — a transient provider outage never 500s
  the user-facing endpoint that triggered the mail.

### Local dev

Default. No env vars required.

```bash
# In your .env (or shell):
# TARMOTO_EMAIL_PROVIDER unset → falls back to the log provider.
```

The dev console prints every send as:

```
[EmailProvider:log] → rider@example.com :: Verify your Tarmoto email [verification]
Hi Rider,
Welcome to Tarmoto …
https://localhost:3000/verify-email?token=…
```

Grep for the `[verification]` / `[password-reset]` / `[subscription-confirmed]`
tag to find a specific mail. The verification / reset URL is in the
plain-text body — copy/paste it into the browser to consume the token.

### Staging / preview

Same defaults as dev unless you want to test real delivery. To enable
Resend:

```env
TARMOTO_EMAIL_PROVIDER=resend
TARMOTO_RESEND_API_KEY=re_test_xxx        # Resend test mode keys are fine
TARMOTO_EMAIL_FROM="Tarmoto <noreply@your-staging-domain.app>"
TARMOTO_EMAIL_REPLY_TO="support@your-staging-domain.app"   # optional
TARMOTO_COMPANION_URL=https://staging.tarmoto.app          # required for token URLs
```

If `TARMOTO_EMAIL_PROVIDER=resend` is set but the API key or `From` is
missing, the boot log emits a `[EmailModule] ... Falling back to the
log provider` warning and outbound mail keeps appearing only in the
console.

### Production

```env
TARMOTO_EMAIL_PROVIDER=resend
TARMOTO_RESEND_API_KEY=<live secret from Resend dashboard>
TARMOTO_EMAIL_FROM="Tarmoto <noreply@tarmoto.app>"   # MUST be a verified Resend domain
TARMOTO_EMAIL_REPLY_TO="support@tarmoto.app"
TARMOTO_COMPANION_URL=https://app.tarmoto.app
TARMOTO_SUPPORT_EMAIL=support@tarmoto.app            # shown in password-changed and deletion mails
TARMOTO_EMAIL_PREFERENCES_URL=https://app.tarmoto.app/settings/notifications  # optional override
```

Add the API key as a sealed secret in whatever env-var store you ship.
Rotate by issuing a new key in the Resend dashboard, swapping the env
var, and revoking the old key.

### Common failures

- **All mail goes to logs in prod** — the bootstrap warning means
  `TARMOTO_EMAIL_PROVIDER=resend` is set but `TARMOTO_RESEND_API_KEY`
  or `TARMOTO_EMAIL_FROM` is empty. Check the secret store and redeploy.
- **`Resend send failed: 422`** — `TARMOTO_EMAIL_FROM` is not a verified
  domain in the Resend project. Verify the domain in Resend, or use a
  `From:` on a domain that is.
- **Verification / reset link 400s with "invalid or expired"** — token
  TTL exceeded (24 h for verification, 15 min for reset) or the token
  was already consumed. Issue a fresh one (`POST /auth/resend-verification`
  while signed in, or `POST /auth/forgot-password` for resets).
- **No `subscription-confirmed` email after a Stripe checkout** — the
  Stripe webhook didn't reach the backend (check
  `TARMOTO_STRIPE_WEBHOOK_SECRET`) or the rider was already in an
  active state before the event (the service de-dupes confirmations to
  avoid spamming on every period update).

## Object storage (avatars / review photos / GDPR exports)

User-uploaded binaries flow through a pluggable `ObjectStorage`
interface (see `apps/backend/src/modules/storage/`). The driver is
chosen by `TARMOTO_STORAGE_DRIVER` and defaults to `local` so
contributors get working avatar uploads without env wiring.

### Drivers

| Driver  | When to use                                                                                      | Notes                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `local` | Local dev. Single-instance prototype deploys.                                                    | Writes to `${TARMOTO_LOCAL_STORAGE_DIR}` (default `<cwd>/uploads`). Served via `/uploads` static route. |
| `s3`    | Any deploy with **more than one backend replica**. Required once we move behind a load balancer. | AWS S3, Cloudflare R2, or MinIO. Uses `@aws-sdk/client-s3` with optional endpoint override.             |

Local dev never needs an S3 bucket — leaving `TARMOTO_STORAGE_DRIVER`
unset keeps the existing filesystem behaviour. The static-file
middleware in `main.ts` mirrors the same env vars so overriding
`TARMOTO_LOCAL_STORAGE_DIR` works end-to-end.

#### Public-base-URL gotcha (LocalStorage behind a proxy)

`LocalStorage.publicUrl()` returns a server-relative path; the
users controller then prefixes it with the public origin before
storing in `users.avatar_url`. Behind a reverse proxy
`req.get('host')` can be an internal pod hostname that mobile
clients can't resolve, so **production must set
`TARMOTO_PUBLIC_BASE_URL`** to the public https origin. Without
it, the avatar upload fails loudly with a 500 rather than
persisting an unreachable URL. Outside production the request-
derived origin is fine, so dev needs no env wiring.

`TARMOTO_PUBLIC_BASE_URL` is the same env var data-export and
reviews already use — it's the single source of truth for the
public origin.

### S3 / R2 / MinIO env vars (staging / prod)

| Variable                       | Required when `s3` | Notes                                                                                                                                                                       |
| ------------------------------ | :----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARMOTO_STORAGE_DRIVER`       |        yes         | Set to `s3`. Anything else (or unset) selects `local`.                                                                                                                      |
| `TARMOTO_S3_BUCKET`            |        yes         | Bucket name. The backend writes under `avatars/`, `reviews/`, `exports/` prefixes — keep them in one bucket.                                                                |
| `TARMOTO_S3_REGION`            |        yes         | AWS region. R2 accepts any string but typically `auto`. MinIO accepts `us-east-1`.                                                                                          |
| `TARMOTO_S3_ACCESS_KEY_ID`     |        yes         | Treat as secret. Store in 1Password / SSM / R2 token.                                                                                                                       |
| `TARMOTO_S3_SECRET_ACCESS_KEY` |        yes         | Treat as secret.                                                                                                                                                            |
| `TARMOTO_S3_ENDPOINT`          |         no         | Endpoint override. Required for R2 (`https://<accountid>.r2.cloudflarestorage.com`) and MinIO (`http://minio:9000`).                                                        |
| `TARMOTO_S3_FORCE_PATH_STYLE`  |         no         | `true` for MinIO and convenient for R2. Default `false` (virtual-hosted, AWS native).                                                                                       |
| `TARMOTO_S3_PUBLIC_URL_BASE`   |         no         | Public URL base for the bucket (CDN domain or R2 custom domain). When unset the backend builds a URL from endpoint + bucket — fine for MinIO, rarely what production wants. |

Avatars and review photos are world-readable, so the bucket must
allow anonymous GET on `avatars/*` and `reviews/*`. GDPR exports
under `exports/*` should be private and served via signed URLs (see
`apps/backend/src/modules/account/data-export/`).

### Local MinIO recipe

```bash
# Spin up MinIO on top of the existing Postgres + Redis stack.
docker compose -f infra/docker/docker-compose.yml --profile s3 up -d

# Create the bucket via the console at http://localhost:9001 (login
# minioadmin/minioadmin) or with the MinIO client:
docker run --rm --network host minio/mc \
  alias set local http://localhost:9000 minioadmin minioadmin
docker run --rm --network host minio/mc mb --ignore-existing local/tarmoto

# Point the backend at it.
export TARMOTO_STORAGE_DRIVER=s3
export TARMOTO_S3_BUCKET=tarmoto
export TARMOTO_S3_REGION=us-east-1
export TARMOTO_S3_ENDPOINT=http://localhost:9000
export TARMOTO_S3_ACCESS_KEY_ID=minioadmin
export TARMOTO_S3_SECRET_ACCESS_KEY=minioadmin
export TARMOTO_S3_FORCE_PATH_STYLE=true
pnpm dev:backend
```

### Migrating existing avatars from local FS to S3

Existing rows have absolute URLs like `https://<api-host>/uploads/avatars/<file>`
— that format works as-is regardless of which backend serves it,
so flipping `TARMOTO_STORAGE_DRIVER` from `local` to `s3` does
**not** break already-stored references _if_ the API host keeps
serving the old `/uploads/avatars/...` path during the transition.

When you want to fully cut over to S3 / R2:

1. Sync the local filesystem to the bucket while the backend is
   still on `local` so the bucket is the new source of truth:

   ```bash
   aws s3 sync /var/lib/tarmoto/uploads/avatars/ \
     s3://tarmoto-prod/avatars/ \
     --content-type 'image/png'   # adjust per file or rely on heuristics
   ```

   For R2 use `aws s3 sync ... --endpoint-url=$R2_ENDPOINT`. For
   MinIO use `mc mirror`.

2. Backfill `users.avatar_url` to point at the bucket's CDN URL:

   ```sql
   UPDATE users
      SET avatar_url = regexp_replace(
        avatar_url,
        '^https?://[^/]+/uploads/avatars/(.*)$',
        'https://cdn.tarmoto.app/avatars/\1'
      )
    WHERE avatar_url ~ '^https?://[^/]+/uploads/avatars/';
   ```

3. Set the env vars (`TARMOTO_STORAGE_DRIVER=s3` plus the bucket
   credentials), redeploy, and verify a new avatar upload lands in
   the bucket and renders end-to-end on the mobile client.

### Symptoms and fixes

- **Avatar uploads return 500 with "invalid storage key"** — the
  storage backend rejected a key. Check the request log for the
  full key; the most common cause is a contributor running with a
  stale build that still passes a constructed path. Rebuild with
  `pnpm build:backend`.
- **Avatars 404 in prod after a hostname change** — old rows
  embedded the previous public hostname into `users.avatar_url`.
  Run a one-off SQL update to rewrite the host (preview against a
  snapshot first):

  ```sql
  UPDATE users
     SET avatar_url = regexp_replace(
       avatar_url,
       '^https?://[^/]+(/uploads/avatars/.*)$',
       'https://api.tarmoto.app\1'
     )
   WHERE avatar_url ~ '^https?://[^/]+/uploads/avatars/';
  ```

- **MinIO bucket missing on first run** — the compose service does
  not auto-create buckets. Use the MinIO console or `mc mb`.
- **R2 SignatureDoesNotMatch errors** — the R2 token must scope
  _Object Read & Write_ on the bucket. R2 also expects
  `TARMOTO_S3_REGION=auto` for some token shapes; if the access
  key looks like an R2 access ID rather than an AWS-style one,
  double-check the dashboard's region setting.

## Incident response checklist (placeholder)

When production deploys land, this section grows. Template for now:

1. **Acknowledge** in the team channel with "investigating" and a timestamp.
2. **Scope** — which app, how many users, what path.
3. **Mitigate first, diagnose later** — roll back if in doubt.
4. **Post-incident** — notes in `docs/reference/incidents/YYYY-MM-DD-<slug>.md` covering symptom, root cause, mitigation, timeline, prevention. Create the `incidents/` folder on first incident.

## Production deploys

The deployment stack is described in
[ADR 0004](../decisions/0004-deployment-stack.md). Terraform IaC
lives under `infra/aws/`; deploy workflows are
`.github/workflows/{backend,companion,mobile-release}.yml`.

### Backend (AWS ECS Fargate)

Normal flow:

1. Merging a backend-touching PR to `main` triggers
   `backend-deploy.yml`, which builds the image, pushes it to ECR
   (`tarmoto-backend-staging:sha-<sha12>`), runs migrations as a
   one-shot ECS RunTask against the new task definition, then
   updates the staging service and waits for stability.
2. The post-deploy smoke step (`scripts/smoke/smoke.sh`) hits
   `/api/v1/healthz`, `/api/v1/jobs/health`, and the auth probe.
   On failure, the workflow rolls the service back to the previous
   active task-definition revision automatically.
3. Promoting to prod is **manual**: tag the chosen commit with
   `backend-vX.Y.Z` and push the tag, or run the workflow with
   `workflow_dispatch -> environment=prod`. The `production`
   GitHub environment requires reviewer approval before the
   deploy step runs.

Manual rollback (if the auto-rollback failed or you need a
different revision):

```bash
ENV=prod  # or staging
aws ecs list-task-definitions \
  --family-prefix "tarmoto-${ENV}-backend" \
  --status ACTIVE --sort DESC --max-items 10
# Pick the revision you want, then:
aws ecs update-service \
  --cluster "tarmoto-${ENV}" \
  --service "tarmoto-${ENV}-backend" \
  --task-definition "tarmoto-${ENV}-backend:NN" \
  --force-new-deployment
aws ecs wait services-stable \
  --cluster "tarmoto-${ENV}" --services "tarmoto-${ENV}-backend"
```

Common failures:

- **"unable to assume role" on OIDC step** — `AWS_DEPLOY_ROLE_ARN_<ENV>`
  secret is missing or the bootstrap role's trust policy isn't
  scoped to this repo's main branch. Re-run
  `infra/aws/bootstrap` and update the role ARN secret.
- **Migration RunTask exits non-zero** — the failing migration is
  echoed from CloudWatch in the workflow log. The ECS service is
  not updated when the migration fails, so the previous task def
  is still serving traffic. Fix the migration on a hotfix branch,
  re-run the deploy.
- **Healthcheck fails after deploy** — most often a missing or
  wrong secret in Secrets Manager (e.g. an unrotated Stripe key).
  Inspect `aws secretsmanager describe-secret --secret-id
tarmoto/<env>/<name>` and confirm the JSON shape matches the
  `secret_arns` map in `infra/aws/envs/<env>/main.tf`. After
  fixing, force a new deployment to pick up the rotated value:

  ```bash
  aws ecs update-service --cluster tarmoto-<env> \
    --service tarmoto-<env>-backend --force-new-deployment
  ```

RDS Postgres + PostGIS:

- **Backups** — point-in-time restore is enabled for 30 days in
  prod (staging: 7). To restore in place, use the AWS console
  (RDS → Snapshots → Restore) which writes a new instance; cut
  over by re-applying Terraform with the new endpoint.
- **PostGIS extension** — created by the first backend migration
  on fresh provisioning. The custom parameter group's
  `shared_preload_libraries` is set to `pg_stat_statements` for
  query observability.

ElastiCache Redis:

- BullMQ jobs that were in flight when Redis failed retry
  idempotently on next enqueue. After a Redis outage, a
  `jobs.cleanup` cycle catches up within an hour. If the queue
  depth chart on CloudWatch is climbing for >15 min, check
  `GET /jobs/health` per "Background jobs aren't running" above.

### Companion (Cloudflare Workers)

The `companion-deploy.yml` workflow ships the companion as a
single Cloudflare Worker via `@opennextjs/cloudflare` (Workers +
Static Assets). It is gated behind a repo variable so it lands as
scaffolding without blocking every PR before the Cloudflare
account is wired up. To enable:

1. Set `COMPANION_DEPLOY_ENABLED=true` under
   **Settings → Secrets and variables → Actions → Variables**.
2. Add `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers
   Subdomain:Read, Account:Read) and `CLOUDFLARE_ACCOUNT_ID` to
   the repo secrets.
3. Set `COMPANION_WORKERS_SUBDOMAIN` to the account's
   `workers.dev` subdomain (e.g. `tarmoto`). The workflow uses it
   to construct the URL it comments on PRs and smoke-tests.
4. Optionally override the Worker name with
   `COMPANION_WORKER_NAME` (default: `tarmoto-companion`).

Once enabled:

- PR previews deploy automatically on every PR via
  `wrangler versions upload --preview-alias pr-<n>`. Each PR
  ends up on `https://pr-<n>-<worker>.<subdomain>.workers.dev`
  and the workflow comments the URL on the PR.
- Production deploys on push to `main` via `wrangler deploy`.
  The smoke step checks the home page returns 200 and contains
  the Tarmoto app shell marker.
- **Rollback**: Cloudflare dashboard → Workers & Pages →
  `<worker>` → Deployments → roll back to a previous version.
  `wrangler rollback` works the same from a checkout of `main`.
- **Deploy failed with auth error** — `CLOUDFLARE_API_TOKEN` is
  missing or has lost the Workers Scripts:Edit / Workers
  Subdomain:Read / Account:Read scopes. Regenerate at
  https://dash.cloudflare.com/profile/api-tokens using the
  "Edit Cloudflare Workers" template scoped to the production
  account.
- **Build fails with "Node.js middleware is not currently
  supported"** — `@opennextjs/cloudflare` requires Edge
  middleware, but Next 16's `proxy.ts` defaults to the Node
  runtime and refuses to opt in. Keep the file named
  `apps/companion/src/middleware.ts` (Next 16 still honours the
  legacy filename) and pin
  `runtime: "experimental-edge"` on the exported `config`. Track
  https://github.com/opennextjs/opennextjs-cloudflare/issues/617
  for native Node-middleware support.

### Mobile (TestFlight + Play Internal)

Releases are manual:

```bash
# Tag-driven (cuts both iOS and Android):
git tag mobile-v1.2.3
git push origin mobile-v1.2.3

# OR via the GitHub UI:
#   Actions → Mobile Release → Run workflow
#   Pick platform, version (X.Y.Z), paste release notes.
```

The version (`X.Y.Z`) is parsed from the tag and validated against
strict semver in the workflow before any signing material is
loaded. The build number is `github.run_number`, which never
collides across reruns.

Rollbacks differ per store:

- **TestFlight** — expire the bad build via App Store Connect →
  TestFlight → Builds. Real rollbacks of an App Store production
  release require Apple's Phased Release pause plus a compensating
  release; document in an incident note when used.
- **Play Internal** — Google Play Console → Internal testing →
  Releases → "Halt rollout" / "Promote previous". Halt-rollout is
  per-track and applies on next install.

Common failures:

- **Match step fails ("not authorized")** — the deploy key on the
  match repo expired or `MATCH_PASSWORD` is wrong. Rotate the
  match repo deploy key, re-encrypt, push.
- **Play upload fails with 403** — service-account JSON missing
  the `Release manager` role on the Play app. Add it via the
  Play Console.
- **AAB rejected for missing/duplicate version code** — version
  code is driven by `github.run_number`, which monotonically
  increases. If you re-ran a workflow on a release that already
  uploaded, Play rejects the second attempt; bump the patch
  version and run again rather than trying to overwrite.

### Secret rotation (prod)

Backend secrets live in AWS Secrets Manager under
`tarmoto/<env>/<name>`. Rotation is operator-driven:

1. Update the secret value:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id tarmoto/prod/jwt \
     --secret-string '"new-value"'
   ```
   For composite secrets (e.g. `tarmoto/prod/stripe`) the value
   must be a single JSON document — see the keys referenced in
   `infra/aws/envs/prod/main.tf` `secret_arns`.
2. Force a new ECS deployment so running tasks pick up the
   rotated value at boot:
   ```bash
   aws ecs update-service \
     --cluster tarmoto-prod \
     --service tarmoto-prod-backend \
     --force-new-deployment
   ```
3. Verify with `scripts/smoke/smoke.sh https://api.tarmoto.app`.

## Out-of-scope (yet)

- Per-PR ephemeral backend stacks
- Multi-region DR
- Automated secret rotation lambdas
- Phased iOS release automation
- S3 bucket lifecycle for failed export uploads (today: 30-day expiry on the exports bucket only)
