# 0001 — TypeORM over Prisma for the backend

**Status:** Accepted
**Date:** 2026-04-14

## Context

Tarmoto's backend is geospatial at its core — ride segments, road surface quality, hazard reports, trip waypoints, and "fun zone" discovery all live on PostGIS geometry. The ORM must:

- Model `geometry(...)` columns with SRID 4326 natively.
- Support spatial indexes (GiST).
- Allow raw SQL or typed expressions for PostGIS functions like `ST_DWithin`, `ST_Intersects`, `ST_MakeLine`, without dropping to a second query layer.
- Let us run spatial `CHECK` constraints and triggers from migrations.

When we started, the team's default ORM choice was Prisma (used in the sibling Nexcue project). Evaluating it against the above:

- Prisma does not ship first-class PostGIS support. The workaround is using `Unsupported("geometry")` and accessing those fields via raw SQL — which loses type safety at exactly the columns we care about most.
- Spatial indexes are not expressible in the Prisma schema; they must be added via side-car `migration.sql` fragments that Prisma can't help review.
- Prisma Migrate was at the time of the decision unable to represent `CHECK` constraints and triggers we rely on for data integrity (e.g. unique active ride per user).

TypeORM, by contrast:

- Has a third-party type (`geometry`) with a well-understood idiom for SRID annotations and `@Index('...', { spatial: true })`.
- Accepts raw SQL in migrations as first-class — we use this for the spatial constraints that migrations would otherwise silently drop.
- Supports `@Check`, `@Unique`, and triggers naturally.

## Decision

The backend uses **TypeORM** with native PostGIS geometry columns. Migrations live under `apps/backend/src/migrations/` and are authored in TypeScript; raw SQL is inlined where PostGIS semantics matter.

Entities live in `apps/backend/src/entities/`. Spatial columns use `@Column({ type: 'geometry', srid: 4326, ... })` with a spatial index where appropriate.

## Consequences

- The team needs a TypeORM migration workflow distinct from Prisma's auto-apply-on-boot pattern. This is documented in [docs/process/typeorm-migrations.md](../process/typeorm-migrations.md).
- `synchronize: true` is **never** enabled — auto-sync silently diverges from our migration history, including the PostGIS bits Prisma would also have missed.
- TypeORM is less strict than Prisma about query builder type inference. Reviewers should verify that service-level contracts (DTOs) are enforced at the NestJS layer, not just by inferring from TypeORM calls.
- If PostGIS features are not used by a given module, that module still benefits from the overall TypeORM decision (one ORM per backend).
- We accept that sharing an ORM with Nexcue is not possible — Nexcue picked Prisma before this constraint was understood.

## Alternatives considered

- **Prisma with raw SQL for PostGIS.** Rejected — the entire point of an ORM is type-safe DB access; losing it on the columns we care most about defeats the purpose.
- **Drizzle.** Smaller ecosystem at the time; spatial support was nascent. Worth revisiting if Drizzle's PostGIS story matures and we need a lighter runtime.
- **Kysely / raw SQL only.** Too much manual wiring for a product with 18 feature modules and 23 entities.
- **Pg-native + custom data mapper.** Same problem as Kysely, plus no migration story.
