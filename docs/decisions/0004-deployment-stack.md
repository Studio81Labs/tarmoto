# 0004 — Deployment stack: Terraform on AWS, Cloudflare Pages for companion, Fastlane for mobile

**Status:** Accepted
**Date:** 2026-05-02

## Context

The PRD architecture targets AWS (ECS + RDS + S3 + CloudFront) for the backend, web hosting for the companion, and the App Store / Play Store for the mobile apps. Today the only deployed surface is the PoC sensor (Cloudflare Pages, see `.github/workflows/poc-deploy.yml`). The backend has no Dockerfile, no IaC is committed, and there are no deploy or release workflows for backend, companion, or mobile.

Issue #286 calls for those gaps to be closed in a single coordinated change so the MVP-blocking deploy story has a checked-in baseline well before Q4 2026.

Forces in play:

- **One stack per concern.** The backend is geospatial (PostGIS) and stateful (Redis pub/sub + BullMQ); it needs a Linux container runtime, a managed Postgres with PostGIS, and a managed Redis. AWS ECS Fargate + RDS + ElastiCache is the boringly-correct match.
- **PR previews matter for the companion.** The companion is the surface that product, design, and ops will spend the most time clicking through pre-launch. Per-PR preview deploys are cheap to set up on Cloudflare Pages or Vercel and expensive to retrofit later.
- **Mobile release is gated, manual, and slow by design.** TestFlight and Play Internal review windows mean releases can't be on every push. They need to be `workflow_dispatch`-only, signed with credentials that never live in the repo, and reproducible from a tag.
- **Operability over cleverness.** Whoever is on call at 3am needs to be able to read this. Terraform state in S3 + DynamoDB lock is well-understood; CDK + bootstrapping + custom constructs is a steeper ramp for the small team.

## Decision

### IaC: Terraform

Infrastructure-as-code is **Terraform** (HCL), committed under `infra/aws/`. The shape:

```
infra/aws/
  modules/        # Reusable building blocks: vpc, rds, redis, ecs-service, ecr, s3-cdn, secrets, alb
  envs/
    staging/      # Per-env root module: backend.tf state config + module wiring + tfvars
    prod/
  README.md       # How to plan/apply, who owns the state bucket, how to bootstrap
```

State lives in an S3 bucket per AWS account with a DynamoDB lock table; bootstrapping that bucket is documented in `infra/aws/README.md` and is intentionally out-of-band (chicken/egg) — Terraform manages everything else. Each environment is a separate root module so `terraform plan` in `envs/prod` cannot accidentally read or mutate staging.

### Backend: ECS Fargate behind ALB, with managed data services

- ECS Fargate service for the API + worker. Single task definition; container concurrency is controlled by `TARMOTO_QUEUE_WORKER_ENABLED` per replica so we can split workers off later without a rebuild.
- ALB in front, with HTTPS via ACM-issued certs.
- RDS Postgres 16 with PostGIS 3.4 (custom parameter group enabling the `postgis` extension on first migrate).
- ElastiCache Redis 8 single-node in staging, replication-group in prod.
- S3 buckets for uploads (avatar / review-photo), data exports (GDPR ZIPs), and tile cache.
- CloudFront in front of S3 for tile and static asset delivery.
- Secrets via AWS Secrets Manager; injected into the task at runtime through the task-definition `secrets` block. Plain config (non-secret env) goes through SSM Parameter Store so changing a value doesn't require a redeploy.
- ECR for container images. The deploy workflow tags by commit SHA; rollback is a re-deploy of a previous SHA's task definition revision.

### Companion: Cloudflare Workers (OpenNext)

Cloudflare, not Vercel. Rationale:

- The PoC sensor already lives on Cloudflare, so the team already has the tokens, the wrangler tooling, and the operational habits.
- Cloudflare's per-version preview URLs are first-class and free.
- Vercel pricing/seat model becomes a budget conversation we don't need to have today.

The companion ships as a single Cloudflare Worker via `@opennextjs/cloudflare` (Workers + Static Assets). Production goes out through `wrangler deploy` on push to `main`; PRs use `wrangler versions upload --preview-alias pr-<n>` for an aliased preview URL that the workflow comments on the PR.

The original 2026-04 plan was Cloudflare Pages with `@cloudflare/next-on-pages`, but `next-on-pages` is deprecated upstream and broke against Next 16's Turbopack workspace-root inference (see [companion-deploy.yml](../../.github/workflows/companion-deploy.yml)).

### Mobile: Fastlane + manual-dispatch GitHub workflow

`apps/mobile/fastlane/` holds the `Fastfile` and `Appfile`. Two lanes per platform:

- iOS: `match` for code-signing identity, `gym` to build, `pilot` to upload to TestFlight.
- Android: bundled signing key from CI secret, `gradle` to assemble the AAB, `supply` to upload to the Play Internal track.

Releases are `workflow_dispatch`-only with a required `release_notes` input and read the version from a git tag (`mobile-vX.Y.Z`). Nothing auto-releases on `main`.

### Smoke tests

A single shared shell script (`scripts/smoke/smoke.sh`) hits `/api/v1/healthz` and a small set of public endpoints over HTTPS, with a configurable base URL. The backend deploy workflow runs it after the new task definition is healthy; the companion deploy workflow runs it against the freshly-deployed Pages URL. A failure rolls back the backend to the previous task-definition revision (handled by `aws-actions/amazon-ecs-deploy-task-definition` + the `wait-for-service-stability` flag plus an explicit rollback step on failure).

## Consequences

- The repo now has a non-trivial Terraform footprint to maintain. We accept that — the alternative is unrecorded clickops.
- Two cloud providers (AWS for backend infrastructure, Cloudflare for companion + PoC). This is a deliberate tradeoff: keeping the companion on Cloudflare avoids re-introducing CloudFront + S3 + cache-invalidation churn for a static-export site, and avoids the Vercel seat-cost growth curve.
- Mobile releases are intentionally a one-button manual operation. We are not optimizing for "ship to the store on every merge" — TestFlight beta cadence and Play Internal review windows make that a footgun.
- Until the AWS account is bootstrapped (state bucket, OIDC role for GitHub Actions, ACM cert, hosted zone), the deploy workflows will be present but cannot run end-to-end. `infra/aws/README.md` documents the bootstrap; the workflows guard secrets so a misconfigured run fails fast with an explicit error rather than silently succeeding.
- Observability (CloudWatch Logs, X-Ray, alarms) is wired in at a baseline level (log group, container insights). A follow-up issue covers full alerting + dashboards — that's a separate decision and can be sized on its own.

## Alternatives considered

- **AWS CDK over Terraform.** TypeScript-native, and a fit with the rest of the codebase. Rejected because it adds CDK bootstrap state, a JSII runtime, and a synth step on every IaC change, all to express a relatively flat set of resources. Terraform's single-tool surface is easier to learn and operate.
- **Vercel for companion.** Better DX for Next.js, especially around middleware. Rejected for the cost-curve / seat-model reasons above and because the team's existing Cloudflare Pages habits already cover the requirement.
- **All-Cloudflare backend (Workers + Hyperdrive + R2).** Tempting given the rest of the surface, but Workers' WebSocket lifetime, BullMQ Redis affinity, and PostGIS query needs push the backend out of the Workers' sweet spot.
- **EAS Build / EAS Submit for mobile.** Polished and good. Rejected for now because it introduces a third paid SaaS dependency and we already need GitHub Actions runners for CI; Fastlane runs on those same runners with no added vendor.
- **Per-PR ephemeral backend stacks.** Out of scope for #286. Worth revisiting once the cost of a Fargate/RDS pair is well understood.
