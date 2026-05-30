# Demo data seeding

`seed-demo-data` populates a **development** database with a catalog of
demo accounts and realistic activity (rides, roads, trips, hazards, road
reviews, shared rides, badges, follows). It exists so QA, demos, and local
UI work can log in as an account that is already in a specific app state
instead of clicking through onboarding to build one by hand.

## Quick start

```bash
pnpm db:up          # Postgres + Redis (skip if already running)
pnpm db:migrate     # apply migrations (only needed on a fresh DB)
pnpm db:seed        # build the backend and seed the dev database
```

`pnpm db:seed` builds the backend and runs
`node dist/scripts/seed-demo-data.js`. If the backend is already built you
can re-run just the script from `apps/backend`:

```bash
pnpm --filter @tarmoto/backend seed:demo
```

## Demo accounts

**Each account's password is its own email** — to log into the companion
or mobile app, put the same email in both the email and password fields
(e.g. `road.hunter@tarmoto.app` / `road.hunter@tarmoto.app`). See
`demoPasswordFor` in
`apps/backend/src/scripts/demo-seed/demo-personas.ts`. Each persona is
tuned to land in a distinct state:

| Email                         | Tier    | State it demonstrates                                   |
| ----------------------------- | ------- | ------------------------------------------------------- |
| `newbie@tarmoto.app`          | free    | Fresh signup — one short ride, no badges (empty states) |
| `weekend.warrior@tarmoto.app` | premium | Mid-tier rider — silver distance, a handful of bronzes  |
| `road.hunter@tarmoto.app`     | pro     | Power user — gold badges, 500+ roads, many shared rides |
| `trip.planner@tarmoto.app`    | premium | Multi-day trips with days + waypoints + folders         |
| `community.scout@tarmoto.app` | premium | Heavy hazard reporting and road reviews; follows all    |

Badges are **not** hand-written: the seeder creates the underlying
activity and then calls the real `BadgesService.checkAndAward`, so a
persona's badges always reflect the production badge rules in
`apps/backend/src/modules/badges/badge-definitions.ts`.

## Options

```bash
node dist/scripts/seed-demo-data.js                              # full re-seed
node dist/scripts/seed-demo-data.js --only=road.hunter@tarmoto.app  # one persona
node dist/scripts/seed-demo-data.js --clean                     # delete demo data, no re-seed
node dist/scripts/seed-demo-data.js --help
```

- The command is **re-runnable**: a full run deletes the demo accounts
  (which cascades to all of their data) and the marker-tagged demo roads
  (`road_segments.road_number LIKE 'DEMO-%'`), then recreates everything.
  It only ever touches its own demo personas and demo roads — other
  accounts in the dev database are left untouched.
- `--only` refreshes a single persona and reuses the existing shared demo
  road pool. The follow graph is rebuilt from all demo accounts currently
  in the database, so the refreshed persona's outgoing follows **and** the
  incoming follows from other demo users are restored.
- The script refuses to run when `NODE_ENV=production` unless `--force` is
  passed. **Do not run this against production data.**

## Implementation

- `apps/backend/src/scripts/seed-demo-data.ts` — CLI entry point. Boots a
  Nest application context (like `cluster-fun-zones`) so it shares the
  app's fully-wired `DataSource` and `BadgesService`.
- `apps/backend/src/scripts/seed-demo-data-args.ts` — argument parsing.
- `apps/backend/src/scripts/demo-seed/demo-personas.ts` — the persona
  catalog (pure data).
- `apps/backend/src/scripts/demo-seed/demo-data-builders.ts` — deterministic
  (seeded-PRNG) geometry and road builders, so re-runs produce stable data.
- `apps/backend/src/scripts/demo-seed/demo-seeder.ts` — DB orchestration.

Tests: pure logic is unit tested under `apps/backend/src/scripts/**`; the
end-to-end seeding flow is covered by
`apps/backend/test/seed-demo-data.e2e-spec.ts` (needs a live DB —
`pnpm db:up && pnpm db:migrate`).
