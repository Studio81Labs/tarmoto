# TypeORM Migrations

Safe workflow for changing the backend database schema. TypeORM reads a compiled `data-source.js`, so there's a build step in the loop that Prisma users don't have.

## Setup

- **DataSource:** `apps/backend/src/data-source.ts` (compiles to `apps/backend/dist/data-source.js`)
- **Migration folder:** `apps/backend/src/migrations/`
- **Migration files:** named `<timestamp>-<PascalCaseName>.ts` (e.g. `1713200000000-AddUniqueActiveRide.ts`)
- **ORM:** TypeORM with native PostGIS geometry columns (Prisma was rejected because it lacks first-class PostGIS)

## Scripts

From `apps/backend/package.json`:

```bash
pnpm db:migrate           # Run pending migrations (requires prior build)
pnpm db:revert            # Revert the most recently applied migration
```

From the repo root:

```bash
pnpm db:up                # Start Postgres + Redis in Docker
pnpm db:down              # Stop Docker services
pnpm db:migrate           # Proxies to backend's db:migrate (includes build)
```

The runtime backend runs pending migrations **automatically on startup** (`database.module.ts` sets `migrationsRun: true`, suppressed only during OpenAPI spec export). So a deploy applies migrations when the new container boots. `pnpm db:migrate` is for applying them out-of-band — locally, or in CI — not a required deploy step.

## Normal workflow

```
1. Edit entities under apps/backend/src/entities/
2. pnpm db:up                    # Make sure Postgres is running
3. pnpm backend:build             # Compile — TypeORM needs dist/data-source.js
4. pnpm --filter @tarmoto/backend exec typeorm migration:generate \
       src/migrations/<ShortName> -d dist/data-source.js
5. Review the generated migration.sql (.ts file) under apps/backend/src/migrations/
6. pnpm backend:build             # Rebuild so the new migration is in dist/
7. pnpm db:migrate                # Apply locally
8. pnpm backend:test && pnpm --filter @tarmoto/backend test:e2e
9. Commit entity + migration together in one commit
```

### Picking a migration name

PascalCase, short, verb-first:

- `AddUniqueActiveRide`
- `FixIsEmergencyDefault`
- `AddChallengeTables`
- `AddPasswordHash`

Rules of thumb:

- Under ~40 characters.
- No timestamps in the name — TypeORM prepends them when generating.
- If the migration does more than one thing, name the main change and cover the rest in a code comment at the top of the file.

### Generating vs writing by hand

- `migration:generate` writes SQL for detected schema drift — good for most changes.
- `migration:create` makes an empty migration — use when generation can't infer what you need (raw SQL, triggers, CHECK constraints, spatial indexes, backfills).

## Review checklist before committing

Open the generated `.ts` file and confirm:

- [ ] Column additions are default-valued or nullable (so in-flight deploys don't crash)
- [ ] No `NOT NULL` column added without a `DEFAULT` when the table has existing rows
- [ ] No column renames that require data migration (split into phases — see below)
- [ ] No dropped columns still referenced by live code (drop in a follow-up release)
- [ ] Indexes added for any new foreign keys or high-volume-lookup columns
- [ ] Unique constraints added at the **DB level** for dedupe-critical surfaces (active ride per user, hazard-report uniqueness keys, etc.)
- [ ] Geometry columns use SRID 4326 and an appropriate spatial index (GiST)
- [ ] PostGIS-specific SQL (if any) reads cleanly — generated migrations sometimes miss PostGIS nuances; edit by hand if needed

## Dangerous changes and how to stage them

Some changes are unsafe as a single migration because the old deploy and the new schema run simultaneously during deploy. Split into phases.

### Rename a column

1. Migration A: add new column, backfill from old, write to both in code.
2. Deploy → let the app write to both columns for at least one release.
3. Migration B: drop old column after code is switched to read from the new one.

### Change a column type

1. Migration A: add new column, backfill, update code to write to both.
2. Migration B: flip reads to new column.
3. Migration C: drop old column.

### Add a `NOT NULL` column to a non-empty table

1. Migration A: add as nullable with a sensible default.
2. Migration B (after backfill completes): flip to `NOT NULL`.

### Drop a column

1. Remove all code references first, deploy.
2. In a follow-up migration, drop the column.

## Testing locally

Before committing a migration:

```bash
pnpm db:migrate           # Apply on dev DB
pnpm backend:test         # Backend unit tests
pnpm --filter @tarmoto/backend test:e2e   # E2E against real DB
```

If you want a fresh slate to verify the migration applies from zero:

```bash
pnpm db:down
# If you've mapped pgdata as a volume, remove it per your docker-compose config
pnpm db:up
pnpm db:migrate           # Should apply all migrations cleanly from empty DB
```

## What not to do

- **Don't edit an already-applied migration.** TypeORM tracks applied migrations in `migrations` (or `typeorm_migrations`) table — rewriting history means dev and prod drift. Add a new migration to fix the problem.
- **Don't use `synchronize: true`** in any environment. It auto-syncs entity changes without migrations, which silently diverges from what we promise in migration history.
- **Don't hand-edit data in production** without taking a `pg_dump` snapshot first.
- **Don't commit an entity change without its migration**, or vice versa. Reviewers should see both together.

## Rolling back

### The safe way (recommended)

Write a new forward migration that reverses the previous one:

```bash
pnpm --filter @tarmoto/backend exec typeorm migration:create \
    src/migrations/RestoreSomeColumn
# Hand-write the `up()` to reverse the offending change.
```

### The fast way (local only)

`pnpm db:revert` — runs the `down()` of the most recent migration. Fine for local experimentation; **do not rely on this in production** (you may not have a working `down()`, and TypeORM's auto-generated `down()` can be incomplete for complex changes).
