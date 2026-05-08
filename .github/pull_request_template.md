## Summary

<!-- What does this PR do? Why? -->

## Title

<!-- Required format: <type>(<scope>): <short description> -->
<!-- Example: feat(backend): add hazard report endpoint -->
<!-- Use scope "cross" for genuinely cross-cutting work -->

## Type

<!-- Check one -->

- [ ] Feature (`type:feature`)
- [ ] Bug fix (`type:bugfix`)
- [ ] Refactor (`type:refactor`)
- [ ] Infrastructure / CI (`type:infra` / `type:ci`)
- [ ] Documentation (`type:docs`)
- [ ] Tests (`type:test`)

## Related Issues

<!-- Link issues: Closes #123, Relates to #456 -->

## Risk / Regression Surface

<!-- What could break? Call out user-facing, contract, data, and operational risk -->

## Changes

<!-- Bullet list of what changed -->

-

## Verification

<!-- Paste the commands you ran and the result -->

- ``

## Contract / Schema / Docs Impact

<!-- Delete bullets that do not apply -->

- [ ] No API contract change
- [ ] OpenAPI updated
- [ ] No database schema change
- [ ] Migration included
- [ ] No product / process docs change
- [ ] Docs updated
- [ ] Model retraining: PR includes a `report.json` from `tools/ml-eval/eval.py` that passes `tools/ml-eval/ci_gate.py` (spec §7)

## Optional Codex Review Prompt

<!-- Paste into a PR comment when you want a stricter Codex pass -->

`@codex review for regressions, missing tests, API contract drift, security, and performance. Ignore pure style nits unless they hide a real defect.`

## Checklist

- [ ] PR title uses conventional commit format with a scope
- [ ] Scope label(s) are present on the PR (auto-applied or added manually)
- [ ] Linked issue includes priority and scope labels
- [ ] Code compiles without errors (`pnpm backend:build && pnpm shared:build`)
- [ ] Tests pass (`pnpm test`)
- [ ] Lint passes (`pnpm lint`)
- [ ] No sensitive data committed (env vars, keys, tokens)
- [ ] Database migrations included (if schema changed)
- [ ] README / docs updated (if applicable)
