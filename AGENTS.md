# Repository Agent Instructions

These instructions are for agents working in the Tarmoto repository. Use them together with the product spec in `docs/specs/`, the contributor guide in `CONTRIBUTING.md`, and the workflow docs in `docs/process/`.

## Working style

- Act as an autonomous senior engineer.
- Do not ask follow-up questions unless you are truly blocked by missing credentials, missing repository access, or conflicting product requirements.
- Make reasonable assumptions, continue, and call out important assumptions in your final summary.
- Complete work end-to-end: analysis, implementation, validation, final diff review, and any PR or issue updates that available tooling supports.

## Scope discipline

- Solve the issue fully, but do not perform unrelated refactors.
- Preserve the existing architecture and conventions unless the issue explicitly requires a change.
- Prefer minimal, safe changes with clear reasoning.
- Keep issues and PRs focused on a single deliverable.

## Codebase conventions

- Follow existing naming, file structure, typing, validation, and error-handling patterns.
- Reuse existing helpers and shared contracts before adding new abstractions.
- Do not introduce broad `try/catch` blocks, silent fallbacks, or behavior that hides failures.
- Keep backend DTOs, OpenAPI output, shared types, and mobile or companion consumers aligned when contracts change.
- When schema or API behavior changes, include the required migration, docs, and follow-up contract updates in the same change.

## Validation

Before considering work complete:

- run relevant unit, integration, or e2e tests for the touched area
- run lint, typecheck, and build commands that meaningfully cover the change when available
- inspect the final diff for regressions, dead code, debug leftovers, accidental formatting churn, and missing tests
- verify the issue acceptance criteria and definition of done are satisfied
- say clearly what you did not validate, if anything could not be run

## Git, issue, and PR workflow

- GitHub Issues are the source of truth for active work. Start from an issue with clear acceptance criteria whenever possible.
- Branch from `main`.
- Use conventional commits and PR titles in the form `<type>(<scope>): <short description>`.
- Scope is required. Valid scopes include `backend`, `mobile`, `companion`, `poc-sensor`, `shared`, `openapi`, `ci`, `infra`, `docs`, `deps`, and `cross`.
- Use `cross` for genuinely cross-cutting work instead of omitting the scope.
- Keep PRs focused, linked to the issue, and aligned with the issue scope.

## Pull request rules

When creating or updating a PR:

- use a concise title aligned with the issue and repo commit conventions
- include a short summary, implementation notes, risks or regression surface, and test evidence
- call out contract, schema, migration, or docs impact explicitly
- link the issue
- make sure the PR carries the right scope labels when automation or repo tooling supports it

## Review handling

If review comments arrive:

- address all actionable comments
- do not argue with style guidance unless it conflicts with correctness, safety, or repo conventions
- rerun relevant checks after changes
- update the PR description if behavior, scope, or risk changed

## Merge readiness

A branch is merge-ready only when:

- required CI checks pass
- no unresolved review comments remain
- the branch is up to date with the base branch or rebased as required by repo policy
- there are no merge conflicts

## Issue handling

When tooling or repository automation supports it:

- when work starts, move or update the issue status
- when a PR is opened, comment with the PR link and a short progress note
- when the PR is merged, update the issue status, post a concise delivery note, and close the issue if that matches the repo workflow

## Project

Tarmoto is a motorcycle companion app with crowdsourced road surface quality intelligence, real-time hazard alerts, and multi-day trip planning. It is a monorepo with a React Native mobile app, a NestJS backend, a Next.js web companion, and a sensor proof of concept.

## Repository layout

- `apps/mobile/` - Bare React Native app (TypeScript), sensors, TF Lite, CarPlay
- `apps/backend/` - NestJS backend (TypeScript) serving both mobile and web
- `apps/companion/` - Next.js + TailwindCSS web companion
- `apps/poc-sensor/` - Vite + React road quality sensor PoC deployed to Cloudflare Pages
- `packages/shared/` - Shared types, constants, DTOs (`@tarmoto/shared`)
- `packages/openapi/` - OpenAPI spec generation from the backend
- `docs/specs/` - Product spec and canonical product behavior
- `docs/decisions/` - ADRs
- `docs/reference/` - Architecture overview and technical reference
- `docs/process/` - Runbooks, testing strategy, migrations, definition of done, issue workflow
- `docs/design/brand/` - Brand reference: logo SVGs + colour palette + typography rules (static markdown)
- `docs/design/database_erd.html` - Generated ERD (static HTML)
- `docs/database/` - PostgreSQL and PostGIS schema documentation

## Tech stack

- Runtime: Node 24+, pnpm workspaces
- Mobile: Bare React Native 0.85, TypeScript, Zustand, MapLibre GL
- Companion: Next.js, TailwindCSS, Zustand, MapLibre GL
- Backend: NestJS 11, TypeORM, TypeScript strict mode
- Database: PostgreSQL 16 + PostGIS 3.4 via Docker
- Maps: MapLibre GL + custom vector tiles
- ML: TensorFlow Lite on-device

## Common commands

```bash
pnpm install              # Install all workspace deps
pnpm dev                  # Backend (3000) + marketing (3001) + companion (3002) in parallel
pnpm backend:dev          # NestJS dev server (watch mode)
pnpm mobile:dev           # Metro bundler
pnpm ios                  # Run on iOS simulator
pnpm android              # Run on Android emulator
pnpm companion:dev        # Companion web dev server
pnpm poc:dev              # PoC sensor app dev server
pnpm db:up                # Start PostgreSQL + Redis via Docker
pnpm db:down              # Stop Docker services
pnpm db:migrate           # Build backend + run TypeORM migrations
pnpm db:seed              # Seed the dev database with demo accounts + activity
pnpm backend:build        # Build backend
pnpm companion:build      # Build companion
pnpm poc:build            # Build PoC sensor
pnpm shared:build         # Build shared package
pnpm test                 # Run tests
pnpm lint                 # Run linting
```

## Repository-specific conventions

- Package names use the `@tarmoto/` scope.
- Call the server app `backend`, not `api`.
- TypeScript strict mode is expected everywhere.
- Shared types and constants belong in `packages/shared`.
- Domain enums such as hazard types, surface types, and ride types belong in `@tarmoto/shared`.
- Application-owned environment variables use the `TARMOTO_` prefix. Carve-outs: Node ecosystem standards (`PORT`, `NODE_ENV`) are not renamed because countless third-party libraries branch on `NODE_ENV` at import time and every Node framework defaults to `PORT`.
- Use TypeORM with native PostGIS geometry columns, not Prisma.
- Backend entities live in `apps/backend/src/entities/` and feature modules in `apps/backend/src/modules/`.
- Docker services live in `infra/docker/docker-compose.yml`.
- Backend stores and serves metric units only: deg C, km/h, meters, and km. Clients convert for display using `@tarmoto/shared` helpers based on user preference.

## Sibling repositories

Tarmoto, `Studio81Labs/nexcue`, and `Studio81Labs/tabletap` are built from the
same template and share their infrastructure shape: monorepo layout, pnpm
workspace + supply-chain posture, the OpenAPI codegen chain, the
Coolify/Cloudflare deploy model, commitlint/husky/Renovate configuration, the
security scan, and the CI conventions below.

- **Nexcue is primary for infrastructure.** CI, deploy, supply-chain and
  tooling conventions land there first and are then ported here. The shared
  Renovate preset (`github>Studio81Labs/.github:renovate-base`) and the
  cross-repo drift check live with that arrangement.
- **The reverse channel is real.** "Primary" is a default, not a direction of
  travel — anything infra-shaped that lands here first should get an issue
  opened on nexcue deliberately.
- **Ported files carry provenance.** Copying beats abstracting at three
  consumers, and a header comment is what keeps copying sustainable:
  `# ported from Studio81Labs/<repo>@<sha>`. The drift check normalises the
  header away before byte-comparing, so provenance and identity coexist.
- **Deliberate divergences are topology, not drift**: React Native mobile
  (siblings: Flutter), TypeORM + PostGIS (siblings: Prisma), Jest (siblings:
  Vitest), and the tarmoto-only surfaces (companion, ingest, poc-sensor,
  ui-preview, packages/ui). The drift checker gates Flutter-toolchain entries
  on `apps/mobile/pubspec.yaml` existing on both sides, so none of this
  reports weekly.
- `scripts/ci/check-sibling-drift.py` runs every Monday
  (`sibling-drift.yml`) against both siblings and maintains one standing
  `infra-drift` issue. It needs the `SIBLING_READ_TOKEN` secret — a
  fine-grained PAT with Contents: Read on both sibling repos.

### CI conventions shared with the siblings

- **Job display names follow `<area>: <what it proves>`**, lowercase after
  the colon (`backend: lint, test & build`, `contract: openapi spec`,
  `security: secrets`). The name is a claim about what the job proves — the
  drift check compares these claims across repos.
- **CI concurrency groups are per-commit**
  (`${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}`),
  never per-ref: with a per-ref group, merges landing in quick succession
  cancel each other and a commit reaches `main` with zero check-runs.
  Deploy workflows group per environment and never cancel in-progress runs.
- **Everything CI executes is pinned**: actions by commit SHA with a
  `# vX.Y.Z` comment, CLIs by exact version (`wrangler@4.123.0`,
  `@sentry/cli@3.6.2`), scanner and service images by tag AND digest.
  Renovate maintains all of them.
- **The main-push workflow list is derived, never typed**:
  `python3 scripts/ci/list-main-push-workflows.py` prints it (and `--tag v…`
  mirrors it for a tag push). Scripts under `scripts/ci/` with test suites or
  `--self-test` run in `ci-scripts.yml`, whose meta-check fails when a suite
  exists unwired.

## Releasing

- **One `v*` tag ships every surface**: `deploy.yml` (backend + ingest to
  production Coolify), `admin-deploy`, `marketing-deploy`,
  `companion-deploy`, and `mobile-release` all fire from it.
- **Tag form: `v<version>+<build>`, build number required** (`v1.2.3+10`),
  enforced before anything ships by `_release-version-gate.yml` →
  `scripts/ci/check-release-tag.sh`: `<version>` must equal
  `apps/mobile/package.json`'s `version` at the tagged commit, `<build>` a
  positive integer. Bump the manifest first, then tag the resulting commit.
  Why the build is in the tag: a resubmission of the same marketing version
  (bug found after upload, before store approval) needs a new build under
  the same X.Y.Z, and tags are immutable — a bare `v1.2.3` would be spent on
  the first attempt. Same rule as the siblings; the SOURCE differs by stack:
  their pubspec holds both halves, while here package.json holds the version
  and **the tag itself is the build number's source of truth** —
  `mobile-release.yml` stamps it into CFBundleVersion and versionCode
  (workflow_dispatch rehearsals fall back to the run number). The build must
  strictly increase across releases (Play's versionCode rule); that floor is
  runbook territory, not the gate's.
- **Tags are immutable — never delete and recut.** Re-pushing a tag re-runs
  the whole production fan-out; the tag's value travels into
  `TARMOTO_APP_VERSION` and the Sentry releases, so its identity must stay
  bound to one commit.
- Backend, ingest, and admin deploy **main HEAD at deploy time** (Coolify
  builds the configured branch); marketing and mobile build **the tagged
  commit**. A server-only change without a tag means dispatching the
  affected deploy workflows directly — none implies another.

## Review guidance

- During code review, do not limit findings to only obvious critical bugs. Surface medium-risk regressions when the user impact or cleanup cost is real.
- Treat these as review-worthy findings, not optional nits:
  - missing or weak tests for behavior changes, edge cases, null or error paths, or regression-prone logic
  - contract drift between backend DTOs, OpenAPI output, shared types, mobile consumers, and companion consumers
  - missing migrations, docs, or follow-up contract updates when schema or API behavior changes
  - metric or unit mistakes, especially backend values that leak non-metric assumptions into persisted or served data
  - performance risks such as N+1 queries, unbounded queries or lists, repeated geospatial work, or avoidable map or render hot paths
  - error-handling, observability, auth, privacy, and secret-handling gaps that would make incidents or data leaks more likely
- Prefer high-signal findings with a concrete failure mode, regression path, or operational risk.
- Skip pure formatting or style comments unless they hide a real defect.
