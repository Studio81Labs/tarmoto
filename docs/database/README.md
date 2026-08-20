# Database schema — where truth lives

The live schema is not documented in this directory. It is defined by:

- **Entities** — [`apps/backend/src/entities/`](../../apps/backend/src/entities/),
  TypeORM with native PostGIS geometry columns
- **The migration chain** — [`apps/backend/src/migrations/`](../../apps/backend/src/migrations/),
  executed in order by `pnpm db:migrate`

To see the current shape of the database, introspect a migrated one:

```bash
pnpm db:up && pnpm db:migrate
docker exec -it tarmoto-db psql -U tarmoto -d tarmoto -c '\d+ users'
```

## `schema.sql` is a frozen baseline, not documentation

[`schema.sql`](./schema.sql) is **executed, not just read**:
`InitSchema1713000000000` loads the file and runs it as the first migration.
It is the April 2026 baseline, and every migration after it owns the changes
made since — 105+ and counting. Because it sits at position one of the chain:

- **Never add objects to it.** A later migration creates them again and a
  from-zero build breaks — that was #1193, and the `IF NOT EXISTS` guards
  scattered through the chain are the scars.
- **Never update or regenerate it to match the live schema.** A dump of a
  migrated database is the same defect at full scale: every object it pulls in
  is one a later migration re-creates.
- Comment-only edits are the only safe edits.

## Why there is no freshness gate

#1154 asked for either a CI gate that keeps `schema.sql` current, or its
retirement. Neither fits a file that is frozen by role: "fresh" is exactly what
it must never become, and retiring it would decapitate the migration chain.
What CI does instead is stronger than a diff gate: the
`backend: schema from zero (real postgres)` job in
[`backend-ci.yml`](../../.github/workflows/backend-ci.yml) migrates an empty
database — executing this file first — on every PR that touches it or the
migrations.

The April-vintage ERD (`docs/design/database_erd.html`) had no executable role
and no regeneration path — hand-maintained mermaid — so it _was_ retired with
#1154. If a rendered schema diagram is ever wanted again, generate it from a
migrated database, and generate it on demand rather than committing it.
