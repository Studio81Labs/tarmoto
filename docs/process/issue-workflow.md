# GitHub Issue Workflow

GitHub Issues are the source of truth for active implementation work. This repo does not keep per-task markdown files under `docs/`.

## When to create or update an issue

- Create an issue for any meaningful feature, bug, refactor, or release-blocking QA item.
- Keep one issue focused on one deliverable that a single owner or agent can finish.
- Split work that spans multiple apps (backend + mobile + companion) or multiple review cycles into smaller linked issues.

## What each issue should contain

- Problem statement or user-facing goal
- Scope and explicit non-goals
- Acceptance criteria
- Verification steps
- Dependencies or ordering notes
- Priority label (`P0`, `P1`, `P2`) and scope label (`backend`, `mobile`, `companion`, `poc-sensor`, `shared`, `openapi`, `infra`, etc.)

## Execution flow

1. Pick the next ready GitHub issue.
2. Copy the issue summary, constraints, and acceptance criteria into your working notes or agent prompt.
3. Implementation must include:
   - Summary of changes
   - Touched file list
   - Verification commands and results
4. Review the result against the issue acceptance criteria and [definition-of-done.md](./definition-of-done.md).
5. Merge only when verification passes and the issue is actually resolved.

## Best practices

- Keep issues atomic and avoid bundling unrelated work.
- Prefer linear dependencies when multiple issues touch the same area (e.g. backend module + mobile screen that consumes it).
- Avoid parallelizing issues that heavily overlap in file ownership.
- If something is ambiguous, choose a safe default that stays inside the current product-spec guardrails and document the choice in the PR.
- Favor tests for sensor classification, ride lifecycle, and safety-critical behavior before UI polish.

## PR naming

See [../../CONTRIBUTING.md#commit-messages-and-pr-titles](../../CONTRIBUTING.md#commit-messages-and-pr-titles). PR titles follow conventional commits with a required scope — `lint-pr.yml` will reject non-conforming titles.

## PR labels

- Every PR should carry the relevant scope label(s).
- `actions/labeler` applies common path-based labels automatically for areas like `backend`, `mobile`, `companion`, `poc-sensor`, `shared`, `openapi`, `ci`, `infra`, `docs`, and `deps`.
- If automation misses a scope, add the label manually before requesting review.
- Keep priority on the linked issue, not the PR, unless triage explicitly asks otherwise.
