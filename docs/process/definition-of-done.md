# Definition of Done (Tarmoto)

A task is **Done** only if all conditions below are satisfied.

## General

- [ ] Requirements satisfied
- [ ] Non-goals not violated
- [ ] Acceptance criteria met
- [ ] Verification steps executed and recorded

## Code Quality

- [ ] Lint passes (`pnpm lint`)
- [ ] Tests added where relevant (see [testing-strategy.md](./testing-strategy.md))
- [ ] No secrets committed
- [ ] Logging contains no PII and no credential material

## Backend-specific

- [ ] API contract stable (OpenAPI kept in sync — see [api-contract-policy](./api-contract-policy.md) once written)
- [ ] DB migration included for any schema change (see [typeorm-migrations.md](./typeorm-migrations.md))
- [ ] PostGIS geometry columns use SRID 4326 (WGS84)
- [ ] Backend stores and returns **metric only** (°C, km/h, m, km). Clients convert for display.
- [ ] Jobs (if any) are idempotent (safe reruns)
- [ ] Unique constraints enforced at DB level for dedupe-critical surfaces

## Mobile-specific

- [ ] Core flows resilient to brief network loss (ride recording must not drop GPS points)
- [ ] Optimistic UI for user-visible actions
- [ ] State persists and recovers after app restart
- [ ] Battery/CPU cost of always-on features (sensor sampling, GPS) kept bounded

## Companion (web) specific

- [ ] Works in modern evergreen browsers (latest Chrome, Firefox, Safari)
- [ ] Loading and error states exist for every async surface

## Documentation

- [ ] Any product behavior change reflected in `docs/specs/`
- [ ] Architectural choice recorded in `docs/decisions/` (new ADR) when non-obvious
- [ ] Deviations from this DoD documented with rationale in the PR description
