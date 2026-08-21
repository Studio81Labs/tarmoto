# Repository Agent Instructions

These instructions are for agents working in the Tarmoto repository. Use them together with the product spec in `docs/specs/`, the contributor guide in `CONTRIBUTING.md`, and the workflow docs in `docs/process/`.

## Working style

- Act as an autonomous senior engineer.
- Do not ask follow-up questions unless you are truly blocked by missing credentials, missing repository access, or conflicting product requirements.
- Make reasonable assumptions, continue, and call out important assumptions in your final summary.
- Complete work end-to-end: analysis, implementation, validation, final diff review, and any PR or issue updates that available tooling supports.

<!-- ported from Studio81Labs/nexcue@6cad363840470c9e8f567281f0ec8829416807b3 -->

## Sub-agent delegation

Delegation exists to spend fewer tokens on the same answer, not to spend more
agents on it. A sub-agent earns its cost when it **reads far more than it reports
back** — a sweep over forty files that returns six `path:line` hits, a
4,000-line CI log that returns the failing assertion. When the brief would take
longer to write than the work takes to do, do the work.

Never repeat a search yourself after delegating it. That pays for it twice, and
the delegated answer was the point.

### Tiers

Tiers are task shapes, not model names. Which model serves a tier is a property
of the harness you are running in, and it changes.

| Tier                          | Task shape                                                                                                                                                            | Setting                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **T1 — mechanical**           | One criterion, checkable answer: locate a symbol, list every call site of a helper, reduce a CI log to its failing lines, confirm a string is absent from a directory | cheapest model on the harness's allowlist, low reasoning effort |
| **T2 — exploratory**          | Judgment, but no decision: trace a flow across layers, triage an unfamiliar failure, first-pass audit of a spec section against the code                              | mid-tier model, medium effort                                   |
| **T3 — decisions and writes** | Not delegated — see the never-delegate list below.                                                                                                                    | the session's own model and effort                              |

A cheap tier typically runs several times cheaper per token than a frontier one,
and a mid tier around half — but the ratio moves with every price change and
differs per vendor. If a decision turns on the exact number, look it up rather
than trusting this sentence.

**Never copy a model name out of a table, including this file's.** Resolve it
from the harness's current allowlist at the moment you dispatch. Model names
churn faster than documentation, and a stale one either hard-errors or silently
routes to a default nobody chose.

### Context is a bigger lever than the tier

A T2 sub-agent given a 200-line brief costs less than a T1 sub-agent handed a
forked transcript. Model choice is the smaller half of the saving; what the
sub-agent reads is the larger one.

- **Spawn with a clean context.** A sub-agent inherits nothing and needs nothing
  — construct exactly the brief it requires. Forking the parent transcript
  re-bills every token in it, on every spawn.
- **Name exact paths in the brief** when they are known. "Check the contract
  surfaces" buys a rediscovery sweep; naming `packages/openapi`,
  `packages/shared` and the consumers does not.
- **Bound the report.** Findings come back as `path:line` plus one sentence, with
  a cap on how many. A sub-agent that returns file contents has moved the tokens,
  not saved them.

### Harness mechanics

|                | Claude Code                                                                              | Codex                                                                              |
| -------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dispatch       | `Agent` tool                                                                             | `spawn_agent`, once the multi-agent tools are enabled                              |
| Context        | fresh by default; `subagent_type: "fork"` inherits the whole transcript and bills for it | spawn into a clean context — the transcript-copying mode is often the default      |
| Tier selection | `model` on the call, or a committed agent definition                                     | whatever the build exposes: a per-spawn override, a role file, or a config default |
| Result         | returns to the tool call                                                                 | `wait_agent`                                                                       |

**Read your own tool schema before you name a parameter.** Codex's spawn tool is
not one shape: the context flag is `fork_turns` in some builds and `fork_context`
in others, and whether the model and reasoning effort can be set per spawn at all
varies by build and by managed-feature config — one build accepts a `model` field
while another rejects it outright. Copying a field name out of a table, including
this one, is how a delegation fails validation instead of running.

Where per-spawn overrides do exist, **set the model and the effort together**.
Setting the model alone resets the child to that model's default effort instead
of inheriting the session's, so a tier picked for cost arrives at an effort
nobody chose.

**Where the harness offers no tier control, no tier was chosen** — the sub-agent
ran at the session's expense. Say so in the handoff rather than reporting a
delegation as if it had been tiered. This repository commits no agent
definitions, so there is no fallback here to catch it.

### Never delegate

- **Any write.** File edits, commits, pushes, `gh` writes, review replies, issue
  updates. A sub-agent proposing a diff is fine; applying it is not.
- **The contract and unit invariants this file documents.** Backend DTOs, OpenAPI
  output, `@tarmoto/shared` types and the mobile and companion consumers have to
  stay aligned, and the backend stores and serves metric only — a sub-agent that
  gets one surface right and misses another ships drift that reads as working
  code.
- **Release work.** Version bumps, tag derivation, the pre-tag checks. Tags are
  immutable and cutting one is a production deploy.
- **Any claim that a check passed.** A sub-agent's "tests pass" is a claim, not
  evidence. Re-run the decisive command yourself before repeating the claim to
  anyone.

### Keeping the cheap tiers honest

- **An empty T1 result is not "nothing found."** Re-run it once at T2 before
  believing it. Absence of evidence from a low-effort sweep is not evidence of
  absence.
- **A sub-agent's finding is a claim, not an instruction.** Check it against the
  code before acting on it.
- **Dispatch independent sub-agents in one message** so they run concurrently.
- **Report what was delegated in the handoff, including what came back empty.** A
  sweep that covered less than it appears to is the failure mode this section is
  most likely to introduce.

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
- When the HTTP contract changes, run both `pnpm openapi:gen` and `pnpm postman:gen` and commit the results — they are separate scripts, and CI gates the generated client and the tracked Postman collection for freshness.
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
- `docs/database/` - Frozen schema baseline executed by the first migration; the live schema is the backend entities + migration chain (see the README there)

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
  `# ported from Studio81Labs/<repo>@<sha>`, or
  `<!-- ported from Studio81Labs/<repo>@<sha> -->` in Markdown, where the `#`
  spelling would render as a heading mid-document. The drift check normalises
  either header away before byte-comparing, so provenance and identity coexist.
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
  the colon (`backend: typecheck, test & build`, `contract: openapi spec`,
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
