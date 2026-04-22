# Contributing to Tarmoto

Human-facing contribution guide. For agent-specific instructions see [AGENTS.md](./AGENTS.md). For product spec see [docs/specs/tarmoto-product-spec.md](./docs/specs/tarmoto-product-spec.md).

## Getting started

1. Read [README.md](./README.md) for the high-level overview.
2. Get the dev environment running:
   ```bash
   pnpm bootstrap           # Installs, starts Postgres + Redis, builds, migrates
   pnpm dev:backend         # Start backend in watch mode
   ```
   The bootstrap script is documented in [README.md#bootstrap-details](./README.md#bootstrap-details).
3. Skim [docs/reference/architecture.md](./docs/reference/architecture.md) to understand the shape of the system.
4. Read the relevant slice of [docs/specs/tarmoto-product-spec.md](./docs/specs/tarmoto-product-spec.md) before touching domain code — this spec is the source of truth.

## Picking work

- Work is tracked in **GitHub Issues**. See [docs/process/issue-workflow.md](./docs/process/issue-workflow.md).
- Pick an issue with a clear priority label and acceptance criteria.
- If nothing fits, open a new issue before starting work.

## Branching

- Branch from `main`.
- Naming: `<type>/<short-slug>` where `<type>` matches the conventional-commit types below. Example: `feat/hazard-report-endpoint`.

## Commit messages and PR titles

Conventional commits. One logical change per commit.

```
<type>(<scope>): <short description>
```

- **Types:** `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `style`
- **Scopes:** `backend`, `mobile`, `companion`, `poc-sensor`, `shared`, `openapi`, `ci`, `infra`, `docs`, `deps`, `cross`
- Scope is required on local commit messages and PR titles. `commitlint` enforces this on every commit via the husky `commit-msg` hook, and `lint-pr.yml` enforces it again on PR titles.
- Use `cross` for genuinely cross-cutting changes instead of omitting the scope.
- Subject must start **lowercase** (enforced by `lint-pr.yml`).

Examples:

- `feat(backend): add road segment review endpoint`
- `fix(mobile): buffer GPS points during brief network loss`
- `refactor(companion): extract trip planner map layer`
- `chore(cross): align PR workflow docs and automation`

## Before opening a PR

Run these locally and make sure they pass:

```bash
pnpm lint                 # Lint all packages
pnpm test                 # Backend unit tests (Jest)
pnpm test --filter backend -- --coverage   # Coverage if you care about a specific module
# E2E tests on backend:
pnpm --filter @tarmoto/backend test:e2e    # Requires `pnpm db:up`

pnpm build:backend        # Verify backend compiles
pnpm build:companion      # Verify companion builds
pnpm build:shared         # Verify shared package builds
```

Mobile and companion don't have tests yet — contribute tests alongside features where reasonable. See [docs/process/testing-strategy.md](./docs/process/testing-strategy.md).

## Pull request flow

1. Push your branch and open a PR against `main`.
2. PR title must follow conventional commits with a required scope (same format as the squash-merge commit). Example: `feat(backend): add hazard report endpoint`.
3. Link the GitHub issue your PR resolves.
4. Make sure the PR has the right scope label(s). `actions/labeler` applies common path-based labels automatically; add any missing labels manually.
5. Use the PR template fully: summarize the change, note the regression surface, record verification, and call out contract / schema / docs impact.
6. Confirm everything in [docs/process/definition-of-done.md](./docs/process/definition-of-done.md) applies.
7. Request human review. Address comments with follow-up commits — don't force-push to shared branches mid-review.
8. Merge via **Squash and merge**. The squash commit message should be the final conventional-commit message.

## Testing

See [docs/process/testing-strategy.md](./docs/process/testing-strategy.md) for where tests live and what gets tested on each surface.

## Database changes

See [docs/process/typeorm-migrations.md](./docs/process/typeorm-migrations.md). Key points:

- Edit an entity in `apps/backend/src/entities/`.
- Rebuild: `pnpm build:backend`.
- Generate a migration: `pnpm --filter @tarmoto/backend typeorm migration:generate src/migrations/<Name> -d dist/data-source.js`.
- Review the generated SQL.
- Run locally: `pnpm db:migrate`.
- Commit entity + migration together.

## Secrets and security

**Never commit:**

- Real `.env` files (only `.env.example` goes in git)
- Database passwords, JWT secrets, OAuth client secrets
- Cloudflare API tokens, AWS credentials, Firebase / APNs keys when added
- Any file matching the rough pattern `*-token*`, `*-secret*`, `*.pem`, `*.key`

**Rules of thumb:**

- If it looks like a credential, it probably is. Reach for an env var with the `TARMOTO_` prefix.
- Request production secrets via the team — don't copy them to your laptop.
- If you accidentally commit a secret, rotate it immediately — even after reverting, assume it's public.

## Documentation

- Product decisions → update [docs/specs/tarmoto-product-spec.md](./docs/specs/tarmoto-product-spec.md) or add an ADR in [docs/decisions/](./docs/decisions/).
- Architectural shape → update [docs/reference/architecture.md](./docs/reference/architecture.md).
- Ops / incident response → [docs/process/runbook.md](./docs/process/runbook.md).
- Anything you had to figure out from scratch is a documentation gap — file an issue or PR the fix.

## Getting help

- Open a GitHub issue with the `question` label.
