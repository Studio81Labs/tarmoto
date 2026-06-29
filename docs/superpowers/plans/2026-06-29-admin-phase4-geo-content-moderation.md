# Admin Phase 4 — Geo-Content Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators a proactive, admin-only surface to browse, search, and moderate user-generated geo-content (hazard reports, road reviews, trip messages) — hide/restore (reversible) or hard-delete (irreversible) with a captured reason — and exclude hidden content from every public read path.

**Architecture:** A migration adds a shared moderation column set (`moderation_status`, `moderation_reason`, `moderated_by`, `moderated_at`) to three existing tables. A single `admin-content` backend module (Approach A — a `CONTENT_TYPES` registry mapping each type to its entity + field accessors) exposes browse/hide/restore/delete over a normalized row shape, reusing the established `InternalGuard` + `@AdminRoles` + `AdminAuditInterceptor` + `setAdminAuditTarget` infrastructure. The existing public read paths gain a `moderation_status = 'visible'` filter. The admin SPA fills its existing `content` route stub with a tabbed, filterable, paginated screen.

**Tech Stack:** NestJS 11 + TypeORM (raw-SQL migrations, PostGIS), Jest 30, `@tarmoto/openapi` → generated `@tarmoto/openapi-client`, Vite + React 19 admin SPA with `@tarmoto/ui` and `openapi-react-query` (`$api`).

## Global Constraints

- Backend stores/serves metric units only (not relevant to this phase — no unit-bearing fields added).
- TypeScript strict mode everywhere.
- Migrations are hand-written raw SQL, registered in BOTH `apps/backend/src/data-source.ts` (import + `migrations:` array — guarded by `migration-registry.spec.ts`) AND `apps/backend/src/modules/database/database.module.ts` (import + `migrations:` array — runtime `migrationsRun`).
- Entities live in `apps/backend/src/entities/`; feature modules in `apps/backend/src/modules/`.
- Conventional commits with a required scope from: `backend`, `mobile`, `companion`, `poc-sensor`, `shared`, `openapi`, `ci`, `infra`, `docs`, `deps`, `cross`, `marketing`. There is NO `admin` scope — admin backend work uses `backend`; admin SPA work uses `backend` too (the SPA lives in the backend-adjacent `apps/admin`; use `cross` when a single commit spans backend + SPA + generated client).
- Run backend tests with `cd apps/backend && npx jest <pattern>` (the repo's `--testPathPatterns` is flaky). Some unrelated specs SIGSEGV under parallel workers — that is pre-existing and not caused by this work.
- Role rank: `read_only(1) < support(2) < admin(3) < super_admin(4)`. `@AdminRoles('support')` means support-and-above; `@AdminRoles('admin')` means admin-and-above.
- Admin list response contract mirrors `AdminUserListResponseDto`: `{ rows, total, page, pageSize }` (this plan uses `rows`, not the design doc's prose `items`, for consistency with the existing admin pagination contract).
- After any DTO/controller change, regenerate the client: `pnpm openapi:gen` (commit the regenerated `packages/openapi-client/src/generated/schema.d.ts`).
- Do NOT add anything to `@tarmoto/shared` — the moderation contract is admin-only and flows through OpenAPI.

---

## File Structure

**Create:**

- `apps/backend/src/migrations/1783000000000-AddContentModeration.ts` — ALTER 3 tables + FK + composite index.
- `apps/backend/src/modules/admin-content/content-types.ts` — `ContentType` enum + `CONTENT_TYPES` registry.
- `apps/backend/src/modules/admin-content/dto/admin-content.dto.ts` — query/response/body DTOs.
- `apps/backend/src/modules/admin-content/admin-content.service.ts` — list/hide/restore/delete.
- `apps/backend/src/modules/admin-content/admin-content.service.spec.ts`
- `apps/backend/src/modules/admin-content/admin-content.controller.ts` — 4 routes.
- `apps/backend/src/modules/admin-content/admin-content.controller.spec.ts`
- `apps/admin/src/data/useAdminContent.ts` — `$api` hooks.
- `apps/admin/src/screens/ContentScreen.tsx` — tabs + filter + search + table + actions.

**Modify:**

- `apps/backend/src/entities/hazard-report.entity.ts`, `road-review.entity.ts`, `trip-message.entity.ts` — + 4 moderation columns each.
- `apps/backend/src/data-source.ts`, `apps/backend/src/modules/database/database.module.ts` — register migration.
- `apps/backend/src/modules/hazards/hazards.service.ts` — exclude hidden (2 sites).
- `apps/backend/src/modules/roads/roads.service.ts` — exclude hidden (3 sites).
- `apps/backend/src/modules/reviews/reviews.service.ts` — exclude hidden (`listForSegment`).
- `apps/backend/src/modules/trips/trip-collab.service.ts` — exclude hidden (`listMessages`).
- `apps/backend/src/modules/admin/admin.module.ts` — register TripMessage entity + controller + service.
- `apps/backend/src/modules/admin/admin-metrics.service.ts` + `dto/admin-metrics.dto.ts` — add `hiddenContent`.
- `apps/admin/src/app/routes.ts` — `content` → `minRole: 'support'`.
- `apps/admin/src/app/App.tsx` — render `ContentScreen`.
- `packages/openapi-client/src/generated/schema.d.ts` — regenerated.

---

## Task 1: Schema — migration + entity columns

**Files:**

- Create: `apps/backend/src/migrations/1783000000000-AddContentModeration.ts`
- Modify: `apps/backend/src/entities/hazard-report.entity.ts`, `apps/backend/src/entities/road-review.entity.ts`, `apps/backend/src/entities/trip-message.entity.ts`
- Modify: `apps/backend/src/data-source.ts`, `apps/backend/src/modules/database/database.module.ts`
- Test: `apps/backend/src/migrations/migration-registry.spec.ts` (existing — must still pass)

**Interfaces:**

- Produces: three entities each carry `moderation_status: string` (default `'visible'`), `moderation_reason: string | null`, `moderated_by: string | null`, `moderated_at: Date | null`. Tables `hazard_reports`, `road_reviews`, `trip_messages` each gain those columns, an FK `..._moderated_by_fkey → admin_users(id) ON DELETE SET NULL`, and a composite index `(moderation_status, created_at)`.

- [ ] **Step 1: Write the migration**

Create `apps/backend/src/migrations/1783000000000-AddContentModeration.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddContentModeration1783000000000 implements MigrationInterface {
  name = "AddContentModeration1783000000000";

  private readonly tables = ["hazard_reports", "road_reviews", "trip_messages"];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN moderation_status VARCHAR(16) NOT NULL DEFAULT 'visible',
          ADD COLUMN moderation_reason VARCHAR(500),
          ADD COLUMN moderated_by UUID,
          ADD COLUMN moderated_at TIMESTAMPTZ;
        ALTER TABLE ${table}
          ADD CONSTRAINT ${table}_moderated_by_fkey
          FOREIGN KEY (moderated_by) REFERENCES admin_users(id) ON DELETE SET NULL;
        CREATE INDEX idx_${table}_moderation ON ${table} (moderation_status, created_at);
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await queryRunner.query(`
        DROP INDEX IF EXISTS idx_${table}_moderation;
        ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_moderated_by_fkey;
        ALTER TABLE ${table}
          DROP COLUMN IF EXISTS moderation_status,
          DROP COLUMN IF EXISTS moderation_reason,
          DROP COLUMN IF EXISTS moderated_by,
          DROP COLUMN IF EXISTS moderated_at;
      `);
    }
  }
}
```

- [ ] **Step 2: Add the columns to each entity**

In `apps/backend/src/entities/hazard-report.entity.ts`, after the `confirmed_at` column (before the `@ManyToOne` relations), add:

```typescript
  @Column({ type: 'varchar', length: 16, default: 'visible' })
  moderation_status!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  moderation_reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  moderated_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  moderated_at!: Date | null;
```

Add the identical four-column block to `apps/backend/src/entities/road-review.entity.ts` (after `photos`, before the `created_at`/relations — placement is cosmetic; keep it before the `@ManyToOne` relations) and to `apps/backend/src/entities/trip-message.entity.ts` (after `body`, before the `created_at`/relations).

- [ ] **Step 3: Register the migration in `data-source.ts`**

In `apps/backend/src/data-source.ts`, add the import alongside the other migration imports (near line 107):

```typescript
import { AddContentModeration1783000000000 } from "./migrations/1783000000000-AddContentModeration.js";
```

And add it as the LAST entry of the `migrations: [...]` array (after `AddFeatureFlags1782000000000`):

```typescript
    AddFeatureFlags1782000000000,
    AddContentModeration1783000000000,
```

- [ ] **Step 4: Register the migration in `database.module.ts`**

In `apps/backend/src/modules/database/database.module.ts`, add the import near the other migration imports (near line 60):

```typescript
import { AddContentModeration1783000000000 } from "../../migrations/1783000000000-AddContentModeration.js";
```

And add it as the LAST entry of that file's `migrations: [...]` array (after `AddFeatureFlags1782000000000`):

```typescript
            AddFeatureFlags1782000000000,
            AddContentModeration1783000000000,
```

- [ ] **Step 5: Run the migration-registry guard + typecheck**

Run: `cd apps/backend && npx jest migration-registry`
Expected: PASS (the new file on disk matches the registered class name in `data-source.ts`).

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors (entities compile with the new columns).

- [ ] **Step 6: Apply and round-trip the migration against a real DB**

The migration-registry spec proves registration but cannot execute raw SQL (no Postgres in unit tests). Verify up/down manually:

Run: `pnpm db:up` (if not already running), then `pnpm db:migrate`
Expected: migration `AddContentModeration1783000000000` runs without error.

Verify the columns landed:
Run: `docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d tarmoto -c "\d hazard_reports" | grep moderation`
Expected: four `moderation_*` rows printed.

If `docker exec` name resolution differs locally, use the container name from `docker ps`. If a live DB is not available in this environment, note that in the task summary and rely on Steps 5 as the gate.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/migrations/1783000000000-AddContentModeration.ts \
  apps/backend/src/entities/hazard-report.entity.ts \
  apps/backend/src/entities/road-review.entity.ts \
  apps/backend/src/entities/trip-message.entity.ts \
  apps/backend/src/data-source.ts \
  apps/backend/src/modules/database/database.module.ts
git commit -m "feat(backend): add content moderation columns to geo-content tables"
```

---

## Task 2: Public-feed exclusion

Hidden content must disappear from every end-user read path. The `'visible'` default means existing rows are unaffected until something is hidden. This task edits five query sites across four files and adds a regression test per file.

**Files:**

- Modify: `apps/backend/src/modules/hazards/hazards.service.ts` (2 sites)
- Modify: `apps/backend/src/modules/roads/roads.service.ts` (3 sites)
- Modify: `apps/backend/src/modules/reviews/reviews.service.ts` (`listForSegment`)
- Modify: `apps/backend/src/modules/trips/trip-collab.service.ts` (`listMessages`)
- Test: the existing `*.service.spec.ts` beside each (add cases)

**Interfaces:**

- Consumes: the `moderation_status` column from Task 1.
- Produces: no new exported symbols; behavior change only.

- [ ] **Step 1: Write failing regression tests**

In `apps/backend/src/modules/hazards/hazards.service.spec.ts`, add a test asserting the shared select base excludes hidden. The cleanest stable assertion is on the SQL the service issues. Add:

```typescript
import { HAZARD_SELECT_BASE } from "./hazards.service.js";

describe("hidden hazards are excluded from public reads", () => {
  it("HAZARD_SELECT_BASE filters on moderation_status", () => {
    expect(HAZARD_SELECT_BASE).toContain("hr.moderation_status = 'visible'");
  });
});
```

This requires exporting the constant — see Step 3.

In `apps/backend/src/modules/roads/roads.service.spec.ts`, add a test that captures the SQL passed to the segment repo and asserts both review queries and the hazard query carry the filter. Use the existing mock harness in that file; append:

```typescript
it("road detail queries exclude hidden hazards and reviews", async () => {
  const queries: string[] = [];
  // `segmentRepoMock` is the existing mocked repo in this spec's setup.
  segmentRepoMock.query.mockImplementation((sql: string) => {
    queries.push(sql);
    return Promise.resolve([]);
  });
  // call whatever public method this spec already exercises for road detail,
  // e.g. await service.getSegmentDetail(SEGMENT_ID); (match the existing spec)
  await service.getSegmentDetail(SEGMENT_ID);
  const joined = queries.join("\n---\n");
  expect(joined).toContain("h.moderation_status = 'visible'");
  expect(joined).toMatch(/road_reviews[\s\S]*moderation_status = 'visible'/);
});
```

Adapt the method name/setup to the spec's existing harness (reuse its `beforeEach`, mocks, and constants — do not invent a new harness).

In `apps/backend/src/modules/reviews/reviews.service.spec.ts`, add:

```typescript
it("listForSegment only returns visible reviews", async () => {
  await service.listForSegment("seg-1");
  expect(reviewRepoMock.find).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        road_segment_id: "seg-1",
        moderation_status: "visible",
      }),
    }),
  );
});
```

In `apps/backend/src/modules/trips/trip-collab.service.spec.ts`, add a test that asserts the message query builder applies the filter. The spec uses a query-builder mock; assert `andWhere` is called with the moderation clause:

```typescript
it("listMessages excludes hidden messages", async () => {
  // reuse the existing membership + qb mock setup from this spec
  await service.listMessages(USER_ID, TRIP_ID, {});
  expect(qbMock.andWhere).toHaveBeenCalledWith(
    "m.moderation_status = 'visible'",
  );
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd apps/backend && npx jest hazards.service roads.service reviews.service trip-collab.service`
Expected: the four new cases FAIL (filter not present yet); `HAZARD_SELECT_BASE` import may also fail to resolve until Step 3.

- [ ] **Step 3: Edit hazards.service.ts**

Export the select base so the test can assert on it — change `const HAZARD_SELECT_BASE = \`` (line ~134) to `export const HAZARD_SELECT_BASE = \``, and add the moderation filter to its `WHERE`:

```typescript
  WHERE hr.is_active = true
    AND hr.expires_at > NOW()
    AND hr.moderation_status = 'visible'
```

In `findActiveHazard` (line ~423), extend the `.where(...)`:

```typescript
      .where(
        "hr.id = :id AND hr.is_active = true AND hr.expires_at > NOW() AND hr.moderation_status = 'visible'",
        { id: hazardId },
      )
```

(This also gates `confirm`/`dismiss`, which call `findActiveHazard` first — a hidden hazard now 404s on every public path.)

- [ ] **Step 4: Edit roads.service.ts**

In the embedded hazard query (line ~184), extend the `WHERE`:

```sql
        WHERE h.road_segment_id = $1
          AND h.is_active = true AND h.expires_at > $2
          AND h.moderation_status = 'visible'
```

In the review aggregate (line ~191), extend its `WHERE`:

```sql
        `SELECT COUNT(*)::int AS count, AVG(rating)::float AS avg_rating
        FROM road_reviews
        WHERE road_segment_id = $1
          AND moderation_status = 'visible'`,
```

In the embedded recent-reviews preview (line ~231), extend its `WHERE`:

```sql
        WHERE rr.road_segment_id = $1
          AND rr.moderation_status = 'visible'
        ORDER BY rr.created_at DESC
        LIMIT $2`,
```

- [ ] **Step 5: Edit reviews.service.ts**

In `listForSegment` (line ~161), add the filter to the `where`:

```typescript
const reviews = await this.reviewRepo.find({
  where: { road_segment_id: segmentId, moderation_status: "visible" },
  relations: ["user"],
  order: { created_at: "DESC" },
});
```

- [ ] **Step 6: Edit trip-collab.service.ts**

In `listMessages` (line ~477), add an `andWhere` to the query builder, right after the `.where('m.trip_id = :tripId', ...)` line:

```typescript
const qb = this.messageRepo
  .createQueryBuilder("m")
  .leftJoinAndSelect("m.author", "author")
  .where("m.trip_id = :tripId", { tripId })
  .andWhere("m.moderation_status = 'visible'")
  .orderBy("m.created_at", "DESC")
  .addOrderBy("m.id", "DESC")
  .take(limit);
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `cd apps/backend && npx jest hazards.service roads.service reviews.service trip-collab.service`
Expected: all PASS, including the four new cases.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/hazards apps/backend/src/modules/roads \
  apps/backend/src/modules/reviews apps/backend/src/modules/trips
git commit -m "feat(backend): exclude hidden content from public geo-content reads"
```

---

## Task 3: admin-content — registry, DTOs, service

**Files:**

- Create: `apps/backend/src/modules/admin-content/content-types.ts`
- Create: `apps/backend/src/modules/admin-content/dto/admin-content.dto.ts`
- Create: `apps/backend/src/modules/admin-content/admin-content.service.ts`
- Test: `apps/backend/src/modules/admin-content/admin-content.service.spec.ts`

**Interfaces:**

- Consumes: the moderation columns (Task 1); `HazardReport`, `RoadReview`, `TripMessage`, `User` entities and their repositories.
- Produces:
  - `enum ContentType { Hazard = 'hazard', Review = 'review', TripMessage = 'trip_message' }`
  - `CONTENT_TYPES: Record<ContentType, ContentTypeConfig>` where `ContentTypeConfig = { entity; auditTargetType: string; textColumn: 'note' | 'comment' | 'body'; toPhotoUrls(row): string[]; toLocation(row): { lat: number; lng: number } | null }`
  - `AdminContentService` with:
    - `list(query: ListContentQueryDto): Promise<ContentListResponseDto>`
    - `hide(type: ContentType, id: string, actingAdminId: string, reason: string | null): Promise<ContentItemDto>`
    - `restore(type: ContentType, id: string): Promise<ContentItemDto>`
    - `remove(type: ContentType, id: string): Promise<void>`
  - DTOs: `ContentType` (re-exported via dto), `CONTENT_STATUS_FILTERS`, `ListContentQueryDto`, `ContentItemDto`, `ContentListResponseDto`, `HideContentDto`.

- [ ] **Step 1: Write the registry**

Create `apps/backend/src/modules/admin-content/content-types.ts`:

```typescript
import type * as GeoJSON from "geojson";
import { HazardReport } from "../../entities/hazard-report.entity.js";
import { RoadReview } from "../../entities/road-review.entity.js";
import { TripMessage } from "../../entities/trip-message.entity.js";

export enum ContentType {
  Hazard = "hazard",
  Review = "review",
  TripMessage = "trip_message",
}

export const CONTENT_TYPE_VALUES = Object.values(ContentType);

export interface ContentTypeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity: new () => any;
  /** audit log target_type written by setAdminAuditTarget */
  auditTargetType: string;
  /** column the free-text search runs against (registry-sourced, never user input) */
  textColumn: "note" | "comment" | "body";
  toPhotoUrls(row: Record<string, unknown>): string[];
  toLocation(row: Record<string, unknown>): { lat: number; lng: number } | null;
}

function pointToLatLng(value: unknown): { lat: number; lng: number } | null {
  const geom = value as GeoJSON.Point | null | undefined;
  if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) {
    return null;
  }
  const [lng, lat] = geom.coordinates;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}

export const CONTENT_TYPES: Record<ContentType, ContentTypeConfig> = {
  [ContentType.Hazard]: {
    entity: HazardReport,
    auditTargetType: "hazard_report",
    textColumn: "note",
    toPhotoUrls: (row) =>
      typeof row.photo_url === "string" && row.photo_url ? [row.photo_url] : [],
    toLocation: (row) => pointToLatLng(row.location),
  },
  [ContentType.Review]: {
    entity: RoadReview,
    auditTargetType: "road_review",
    textColumn: "comment",
    toPhotoUrls: (row) =>
      Array.isArray(row.photos) ? (row.photos as string[]) : [],
    toLocation: () => null,
  },
  [ContentType.TripMessage]: {
    entity: TripMessage,
    auditTargetType: "trip_message",
    textColumn: "body",
    toPhotoUrls: () => [],
    toLocation: () => null,
  },
};
```

- [ ] **Step 2: Write the DTOs**

Create `apps/backend/src/modules/admin-content/dto/admin-content.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { ContentType } from "../content-types.js";

export const CONTENT_STATUS_FILTERS = ["visible", "hidden", "all"] as const;
export type ContentStatusFilter = (typeof CONTENT_STATUS_FILTERS)[number];

export class ListContentQueryDto {
  @ApiProperty({ enum: ContentType, description: "Content type to browse." })
  @IsEnum(ContentType)
  type!: ContentType;

  @ApiPropertyOptional({
    enum: CONTENT_STATUS_FILTERS,
    description: "Filter by moderation status. Defaults to all.",
  })
  @IsOptional()
  @IsIn(CONTENT_STATUS_FILTERS)
  status?: ContentStatusFilter;

  @ApiPropertyOptional({ description: "Substring match on the content text." })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class HideContentDto {
  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class ContentLocationDto {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
}

export class ContentItemDto {
  @ApiProperty({ enum: ContentType }) type!: ContentType;
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) authorId!: string | null;
  @ApiProperty({ nullable: true }) authorName!: string | null;
  @ApiProperty({ nullable: true }) text!: string | null;
  @ApiProperty({ type: [String] }) photoUrls!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) moderationReason!: string | null;
  @ApiProperty({ nullable: true }) moderatedAt!: string | null;
  @ApiProperty({ type: ContentLocationDto, nullable: true })
  location!: ContentLocationDto | null;
}

export class ContentListResponseDto {
  @ApiProperty({ type: [ContentItemDto] }) rows!: ContentItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
```

- [ ] **Step 3: Write the failing service tests**

Create `apps/backend/src/modules/admin-content/admin-content.service.spec.ts`:

```typescript
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AdminContentService } from "./admin-content.service.js";
import { ContentType } from "./content-types.js";

const HAZARD_ROW = {
  id: "h1",
  user_id: "u1",
  note: "big pothole",
  photo_url: "https://cdn/x.jpg",
  location: { type: "Point", coordinates: [10, 50] },
  created_at: new Date("2026-01-01T00:00:00Z"),
  moderation_status: "visible",
  moderation_reason: null,
  moderated_at: null,
};

function makeQb(rows: object[], total: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ["where", "andWhere", "orderBy", "skip", "take"]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return qb;
}

function makeRepo(qb: object, over: Record<string, unknown> = {}) {
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOne: jest.fn().mockResolvedValue(HAZARD_ROW),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...over,
  };
}

function makeUserRepo() {
  return {
    find: jest.fn().mockResolvedValue([{ id: "u1", display_name: "Alice" }]),
  };
}

function build(hazardRepo: object, userRepo: object) {
  // review + trip repos unused in these cases — pass minimal stubs
  const stub = makeRepo(makeQb([], 0));
  return new AdminContentService(
    hazardRepo as never,
    stub as never,
    stub as never,
    userRepo as never,
  );
}

describe("AdminContentService", () => {
  it("list() projects a normalized row with author name and location", async () => {
    const qb = makeQb([HAZARD_ROW], 1);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    const res = await svc.list({ type: ContentType.Hazard });
    expect(res.total).toBe(1);
    expect(res.rows[0]).toMatchObject({
      type: "hazard",
      id: "h1",
      authorId: "u1",
      authorName: "Alice",
      text: "big pothole",
      photoUrls: ["https://cdn/x.jpg"],
      status: "visible",
      location: { lat: 50, lng: 10 },
    });
  });

  it('list() applies a status filter when not "all"', async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, status: "hidden" });
    expect(qb.andWhere).toHaveBeenCalledWith("c.moderation_status = :status", {
      status: "hidden",
    });
  });

  it('list() does not filter status when "all"', async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, status: "all" });
    const statusCalls = qb.andWhere.mock.calls.filter((c) =>
      String(c[0]).includes("moderation_status"),
    );
    expect(statusCalls).toHaveLength(0);
  });

  it("list() escapes LIKE wildcards in the search term", async () => {
    const qb = makeQb([], 0);
    const repo = makeRepo(qb);
    const svc = build(repo, makeUserRepo());
    await svc.list({ type: ContentType.Hazard, q: "50%_off" });
    expect(qb.andWhere).toHaveBeenCalledWith("c.note ILIKE :q", {
      q: "%50\\%\\_off%",
    });
  });

  it("hide() sets status, reason, actor, timestamp", async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await svc.hide(ContentType.Hazard, "h1", "admin-9", "spam");
    expect(repo.update).toHaveBeenCalledWith(
      { id: "h1" },
      expect.objectContaining({
        moderation_status: "hidden",
        moderation_reason: "spam",
        moderated_by: "admin-9",
      }),
    );
  });

  it("hide() throws NotFound when the row is missing", async () => {
    const repo = makeRepo(makeQb([], 0), {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const svc = build(repo, makeUserRepo());
    await expect(
      svc.hide(ContentType.Hazard, "nope", "admin-9", null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("restore() clears the moderation fields", async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await svc.restore(ContentType.Hazard, "h1");
    expect(repo.update).toHaveBeenCalledWith(
      { id: "h1" },
      {
        moderation_status: "visible",
        moderation_reason: null,
        moderated_by: null,
        moderated_at: null,
      },
    );
  });

  it("remove() throws NotFound on zero-affected delete", async () => {
    const repo = makeRepo(makeQb([], 0), {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const svc = build(repo, makeUserRepo());
    await expect(svc.remove(ContentType.Hazard, "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects an unknown content type", async () => {
    const repo = makeRepo(makeQb([], 0));
    const svc = build(repo, makeUserRepo());
    await expect(svc.list({ type: "bogus" as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
```

- [ ] **Step 4: Run the service tests to confirm they fail**

Run: `cd apps/backend && npx jest admin-content.service`
Expected: FAIL with "Cannot find module './admin-content.service.js'".

- [ ] **Step 5: Write the service**

Create `apps/backend/src/modules/admin-content/admin-content.service.ts`:

```typescript
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository, type ObjectLiteral } from "typeorm";
import { HazardReport } from "../../entities/hazard-report.entity.js";
import { RoadReview } from "../../entities/road-review.entity.js";
import { TripMessage } from "../../entities/trip-message.entity.js";
import { User } from "../../entities/user.entity.js";
import {
  CONTENT_TYPES,
  ContentType,
  type ContentTypeConfig,
} from "./content-types.js";
import {
  ContentItemDto,
  ContentListResponseDto,
  ListContentQueryDto,
} from "./dto/admin-content.dto.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Escape LIKE/ILIKE wildcards so user input is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class AdminContentService {
  private readonly repos: Record<ContentType, Repository<ObjectLiteral>>;

  constructor(
    @InjectRepository(HazardReport)
    hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    reviews: Repository<RoadReview>,
    @InjectRepository(TripMessage)
    messages: Repository<TripMessage>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    this.repos = {
      [ContentType.Hazard]: hazards as Repository<ObjectLiteral>,
      [ContentType.Review]: reviews as Repository<ObjectLiteral>,
      [ContentType.TripMessage]: messages as Repository<ObjectLiteral>,
    };
  }

  private configFor(type: ContentType): {
    config: ContentTypeConfig;
    repo: Repository<ObjectLiteral>;
  } {
    const config = CONTENT_TYPES[type];
    const repo = this.repos[type];
    if (!config || !repo) {
      throw new BadRequestException(`Unknown content type: ${String(type)}`);
    }
    return { config, repo };
  }

  async list(query: ListContentQueryDto): Promise<ContentListResponseDto> {
    const { config, repo } = this.configFor(query.type);
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const qb = repo
      .createQueryBuilder("c")
      .orderBy("c.created_at", "DESC")
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status && query.status !== "all") {
      qb.andWhere("c.moderation_status = :status", { status: query.status });
    }
    const term = query.q?.trim();
    if (term) {
      qb.andWhere(`c.${config.textColumn} ILIKE :q`, {
        q: `%${escapeLike(term)}%`,
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    const items = await this.project(query.type, config, rows);
    return { rows: items, total, page, pageSize };
  }

  async hide(
    type: ContentType,
    id: string,
    actingAdminId: string,
    reason: string | null,
  ): Promise<ContentItemDto> {
    const { repo } = this.configFor(type);
    const result = await repo.update(
      { id },
      {
        moderation_status: "hidden",
        moderation_reason: reason ?? null,
        moderated_by: actingAdminId,
        moderated_at: new Date(),
      },
    );
    if (!result.affected) throw new NotFoundException("Content not found");
    return this.getOne(type, id);
  }

  async restore(type: ContentType, id: string): Promise<ContentItemDto> {
    const { repo } = this.configFor(type);
    const result = await repo.update(
      { id },
      {
        moderation_status: "visible",
        moderation_reason: null,
        moderated_by: null,
        moderated_at: null,
      },
    );
    if (!result.affected) throw new NotFoundException("Content not found");
    return this.getOne(type, id);
  }

  async remove(type: ContentType, id: string): Promise<void> {
    const { repo } = this.configFor(type);
    const result = await repo.delete({ id });
    if (!result.affected) throw new NotFoundException("Content not found");
  }

  private async getOne(type: ContentType, id: string): Promise<ContentItemDto> {
    const { config, repo } = this.configFor(type);
    const row = await repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException("Content not found");
    const [item] = await this.project(type, config, [row]);
    return item;
  }

  private async project(
    type: ContentType,
    config: ContentTypeConfig,
    rows: ObjectLiteral[],
  ): Promise<ContentItemDto[]> {
    const authorIds = [
      ...new Set(
        rows
          .map((r) => r.user_id as string | null | undefined)
          .filter((v): v is string => !!v),
      ),
    ];
    const nameById = new Map<string, string>();
    if (authorIds.length > 0) {
      const authors = await this.users.find({
        where: { id: In(authorIds) },
        select: { id: true, display_name: true },
      });
      for (const a of authors) nameById.set(a.id, a.display_name);
    }

    return rows.map((row) => {
      const authorId = (row.user_id as string | null) ?? null;
      const createdAt = row.created_at as Date;
      const moderatedAt = row.moderated_at as Date | null;
      return {
        type,
        id: row.id as string,
        authorId,
        authorName: authorId ? (nameById.get(authorId) ?? null) : null,
        text: (row[config.textColumn] as string | null) ?? null,
        photoUrls: config.toPhotoUrls(row),
        createdAt: createdAt.toISOString(),
        status: row.moderation_status as string,
        moderationReason: (row.moderation_reason as string | null) ?? null,
        moderatedAt: moderatedAt ? moderatedAt.toISOString() : null,
        location: config.toLocation(row),
      };
    });
  }
}
```

- [ ] **Step 6: Run the service tests to confirm they pass**

Run: `cd apps/backend && npx jest admin-content.service`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-content/content-types.ts \
  apps/backend/src/modules/admin-content/dto/admin-content.dto.ts \
  apps/backend/src/modules/admin-content/admin-content.service.ts \
  apps/backend/src/modules/admin-content/admin-content.service.spec.ts
git commit -m "feat(backend): add admin-content moderation service + registry"
```

---

## Task 4: admin-content controller + module wiring + metrics + OpenAPI

**Files:**

- Create: `apps/backend/src/modules/admin-content/admin-content.controller.ts`
- Test: `apps/backend/src/modules/admin-content/admin-content.controller.spec.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`
- Modify: `apps/backend/src/modules/admin/admin-metrics.service.ts`, `apps/backend/src/modules/admin/dto/admin-metrics.dto.ts`
- Modify: `packages/openapi-client/src/generated/schema.d.ts` (regenerated)

**Interfaces:**

- Consumes: `AdminContentService` (Task 3); `AdminRequest` (`req.adminUser?.id`), `setAdminAuditTarget`, `@AdminRoles`, `ParseEnumPipe`, `ParseUUIDPipe`.
- Produces: REST endpoints `GET /admin/content`, `POST /admin/content/:type/:id/hide`, `POST /admin/content/:type/:id/restore`, `DELETE /admin/content/:type/:id`; `AdminMetricsDto.hiddenContent: number`.

- [ ] **Step 1: Write the failing controller test**

Create `apps/backend/src/modules/admin-content/admin-content.controller.spec.ts`:

```typescript
import { AdminContentController } from "./admin-content.controller.js";
import { getAdminAuditTarget } from "../admin/admin-audit-context.js";
import { ContentType } from "./content-types.js";

function makeService() {
  return {
    list: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    hide: jest.fn().mockResolvedValue({ id: "h1" }),
    restore: jest.fn().mockResolvedValue({ id: "h1" }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function makeReq() {
  return { adminUser: { id: "admin-9", role: "admin" } } as never;
}

describe("AdminContentController", () => {
  it("hide() delegates with the acting admin id and sets the audit target", async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.hide(req, ContentType.Hazard, "h1", { reason: "spam" });
    expect(service.hide).toHaveBeenCalledWith(
      ContentType.Hazard,
      "h1",
      "admin-9",
      "spam",
    );
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: "hazard_report",
      target_id: "h1",
    });
  });

  it("restore() sets the audit target", async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.restore(req, ContentType.Review, "r1");
    expect(service.restore).toHaveBeenCalledWith(ContentType.Review, "r1");
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: "road_review",
      target_id: "r1",
    });
  });

  it("remove() sets the audit target and delegates", async () => {
    const service = makeService();
    const ctrl = new AdminContentController(service as never);
    const req = makeReq();
    await ctrl.remove(req, ContentType.TripMessage, "m1");
    expect(service.remove).toHaveBeenCalledWith(ContentType.TripMessage, "m1");
    expect(getAdminAuditTarget(req)).toEqual({
      target_type: "trip_message",
      target_id: "m1",
    });
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `cd apps/backend && npx jest admin-content.controller`
Expected: FAIL with "Cannot find module './admin-content.controller.js'".

- [ ] **Step 3: Write the controller**

Create `apps/backend/src/modules/admin-content/admin-content.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminRoles } from "../admin-auth/admin-role.decorator.js";
import type { AdminRequest } from "../admin/internal.guard.js";
import { setAdminAuditTarget } from "../admin/admin-audit-context.js";
import { AdminContentService } from "./admin-content.service.js";
import { CONTENT_TYPES, ContentType } from "./content-types.js";
import {
  ContentItemDto,
  ContentListResponseDto,
  HideContentDto,
  ListContentQueryDto,
} from "./dto/admin-content.dto.js";

@ApiTags("admin")
@Controller("admin")
export class AdminContentController {
  constructor(private readonly service: AdminContentService) {}

  @Get("content")
  @AdminRoles("support")
  @ApiOperation({ summary: "Browse user-generated content for moderation" })
  @ApiResponse({ status: 200, type: ContentListResponseDto })
  list(@Query() query: ListContentQueryDto): Promise<ContentListResponseDto> {
    return this.service.list(query);
  }

  @Post("content/:type/:id/hide")
  @AdminRoles("support")
  @ApiOperation({ summary: "Hide a content item from public surfaces" })
  @ApiResponse({ status: 201, type: ContentItemDto })
  async hide(
    @Req() req: AdminRequest,
    @Param("type", new ParseEnumPipe(ContentType)) type: ContentType,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: HideContentDto,
  ): Promise<ContentItemDto> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.hide(type, id, req.adminUser!.id, dto.reason ?? null);
  }

  @Post("content/:type/:id/restore")
  @AdminRoles("support")
  @ApiOperation({ summary: "Restore a previously hidden content item" })
  @ApiResponse({ status: 201, type: ContentItemDto })
  async restore(
    @Req() req: AdminRequest,
    @Param("type", new ParseEnumPipe(ContentType)) type: ContentType,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ContentItemDto> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.restore(type, id);
  }

  @Delete("content/:type/:id")
  @AdminRoles("admin")
  @HttpCode(204)
  @ApiOperation({ summary: "Permanently delete a content item" })
  async remove(
    @Req() req: AdminRequest,
    @Param("type", new ParseEnumPipe(ContentType)) type: ContentType,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    setAdminAuditTarget(req, {
      target_type: CONTENT_TYPES[type].auditTargetType,
      target_id: id,
    });
    return this.service.remove(type, id);
  }
}
```

- [ ] **Step 4: Register the controller + service + TripMessage entity in admin.module.ts**

In `apps/backend/src/modules/admin/admin.module.ts`:

Add the `TripMessage` entity import (near the other entity imports):

```typescript
import { TripMessage } from "../../entities/trip-message.entity.js";
```

Add the admin-content imports (near the other feature-module imports):

```typescript
import { AdminContentController } from "../admin-content/admin-content.controller.js";
import { AdminContentService } from "../admin-content/admin-content.service.js";
```

Add `TripMessage` to the `TypeOrmModule.forFeature([...])` array (the other content entities `HazardReport`, `RoadReview`, and `User` are already present):

```typescript
      Trip,
      TripMessage,
      CommuteRoute,
      FeatureFlag,
```

Add `AdminContentController` to `controllers: [...]` and `AdminContentService` to `providers: [...]`:

```typescript
  controllers: [
    AdminMetricsController,
    AdminUsersController,
    AdminAdminsController,
    AdminFlagsController,
    AdminContentController,
  ],
  providers: [
    AdminAuditService,
    AdminMetricsService,
    AdminUsersService,
    AdminAdminsService,
    AdminFlagsService,
    AdminContentService,
    InternalGuard,
    { provide: APP_GUARD, useClass: InternalGuard },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
```

- [ ] **Step 5: Run the controller test to confirm it passes**

Run: `cd apps/backend && npx jest admin-content.controller`
Expected: all PASS.

- [ ] **Step 6: Add the `hiddenContent` metric (failing test first)**

In `apps/backend/src/modules/admin/admin-metrics.service.spec.ts` (if it exists, append; otherwise add the assertion to the existing metrics test that builds the service — match its harness), add a case asserting `hiddenContent` sums hidden across the three repos. If no metrics service spec exists, skip the dedicated test and rely on Step 8's typecheck + the existing metrics controller/e2e coverage; note this in the task summary.

Append to the metrics service spec's repo mocks a `count` that resolves per-repo, and assert:

```typescript
it("snapshot() includes hiddenContent summed across content tables", async () => {
  // hazardRepo/reviewRepo/tripRepo .count mocked to 2, 1, 3 respectively
  const res = await service.snapshot();
  expect(res.hiddenContent).toBe(6);
});
```

- [ ] **Step 7: Implement the metric**

In `apps/backend/src/modules/admin/dto/admin-metrics.dto.ts`, add:

```typescript
  @ApiProperty() hiddenContent!: number;
```

In `apps/backend/src/modules/admin/admin-metrics.service.ts`, inject the three content repos and sum hidden counts:

```typescript
import { HazardReport } from "../../entities/hazard-report.entity.js";
import { RoadReview } from "../../entities/road-review.entity.js";
import { TripMessage } from "../../entities/trip-message.entity.js";
```

Add constructor params:

```typescript
    @InjectRepository(HazardReport)
    private readonly hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviews: Repository<RoadReview>,
    @InjectRepository(TripMessage)
    private readonly messages: Repository<TripMessage>,
```

Extend `snapshot()`:

```typescript
  async snapshot(): Promise<AdminMetricsDto> {
    const [
      users,
      closures,
      activeRides,
      featureFlags,
      hiddenHazards,
      hiddenReviews,
      hiddenMessages,
    ] = await Promise.all([
      this.users.count({ where: { deleted_at: IsNull() } }),
      this.closures.count(),
      this.rides.count({ where: { status: 'active' } }),
      this.flags.count(),
      this.hazards.count({ where: { moderation_status: 'hidden' } }),
      this.reviews.count({ where: { moderation_status: 'hidden' } }),
      this.messages.count({ where: { moderation_status: 'hidden' } }),
    ]);
    return {
      users,
      activeRides,
      featureFlags,
      closures,
      hiddenContent: hiddenHazards + hiddenReviews + hiddenMessages,
    };
  }
```

(`HazardReport` and `RoadReview` are already in `admin.module` `forFeature`; `TripMessage` was added in Step 4. No further module change needed for the metrics service.)

- [ ] **Step 8: Run the full admin-content + metrics suites + typecheck**

Run: `cd apps/backend && npx jest admin-content admin-metrics`
Expected: all PASS.

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Regenerate the OpenAPI client**

Run: `pnpm openapi:gen`
Expected: `packages/openapi-client/src/generated/schema.d.ts` updates to include the `/admin/content` paths, `ContentItemDto`, `ContentListResponseDto`, and `hiddenContent` on the metrics schema.

Verify the new paths landed:
Run: `grep -c "admin/content" packages/openapi-client/src/generated/schema.d.ts`
Expected: a non-zero count.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/modules/admin-content/admin-content.controller.ts \
  apps/backend/src/modules/admin-content/admin-content.controller.spec.ts \
  apps/backend/src/modules/admin/admin.module.ts \
  apps/backend/src/modules/admin/admin-metrics.service.ts \
  apps/backend/src/modules/admin/dto/admin-metrics.dto.ts \
  apps/backend/src/modules/admin/admin-metrics.service.spec.ts \
  packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(cross): add admin-content moderation endpoints + hidden-content metric"
```

---

## Task 5: SPA — Content screen

**Files:**

- Create: `apps/admin/src/data/useAdminContent.ts`
- Create: `apps/admin/src/screens/ContentScreen.tsx`
- Modify: `apps/admin/src/app/routes.ts`, `apps/admin/src/app/App.tsx`
- Test: `apps/admin/src/screens/ContentScreen.test.tsx`

**Interfaces:**

- Consumes: the generated `components["schemas"]["ContentItemDto"]` + `/api/v1/admin/content...` paths from Task 4; `canAccess` from `../lib/roleRank.js`; `AdminRole` type.
- Produces: `ContentScreen` component taking `{ currentRole: AdminRole }`; rendered by `App.tsx` for the `content` route.

- [ ] **Step 1: Write the data hooks**

Create `apps/admin/src/data/useAdminContent.ts`:

```typescript
import { $api } from "./apiClient.js";

export type ContentTypeParam = "hazard" | "review" | "trip_message";
export type ContentStatusParam = "visible" | "hidden" | "all";

export function useAdminContentList(params: {
  type: ContentTypeParam;
  status?: ContentStatusParam;
  q?: string;
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/api/v1/admin/content", {
    params: { query: params },
  });
}

export function useHideContent() {
  return $api.useMutation("post", "/api/v1/admin/content/{type}/{id}/hide");
}

export function useRestoreContent() {
  return $api.useMutation("post", "/api/v1/admin/content/{type}/{id}/restore");
}

export function useDeleteContent() {
  return $api.useMutation("delete", "/api/v1/admin/content/{type}/{id}");
}
```

- [ ] **Step 2: Set the route `minRole`**

In `apps/admin/src/app/routes.ts`, change the `content` entry:

```typescript
  { key: "content", label: "Content", minRole: "support" },
```

- [ ] **Step 3: Write the Content screen**

Create `apps/admin/src/screens/ContentScreen.tsx`. It mirrors `FeatureFlagsScreen`/`UsersScreen` patterns (the `readErrorMessage` helper, `DataTable`, `Pill`, `Alert`, `Button`, `Input`, `Select`, `PageHeader`, pagination), gates Delete on `admin`+ via `canAccess`, and prompts for a hide reason via `window.prompt`:

```tsx
import { useState } from "react";
import type { components } from "@tarmoto/openapi-client";
import {
  Alert,
  Button,
  DataTable,
  type DataTableColumn,
  Input,
  PageHeader,
  Pill,
  Select,
} from "@tarmoto/ui";
import type { AdminRole } from "../lib/roleRank.js";
import { canAccess } from "../lib/roleRank.js";
import {
  type ContentStatusParam,
  type ContentTypeParam,
  useAdminContentList,
  useDeleteContent,
  useHideContent,
  useRestoreContent,
} from "../data/useAdminContent.js";

type ContentItem = components["schemas"]["ContentItemDto"];

const PAGE_SIZE = 25;

const TYPE_TABS: ReadonlyArray<{ key: ContentTypeParam; label: string }> = [
  { key: "hazard", label: "Hazards" },
  { key: "review", label: "Reviews" },
  { key: "trip_message", label: "Messages" },
];

function readErrorMessage(err: unknown, fallback: string): string {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  const serverMsg = (err as { message?: string } | undefined)?.message;
  if (statusCode === 404)
    return serverMsg ?? "Content not found (it may have been deleted).";
  if (statusCode === 403) return serverMsg ?? "Permission denied.";
  return serverMsg ?? fallback;
}

export function ContentScreen({ currentRole }: { currentRole: AdminRole }) {
  const [type, setType] = useState<ContentTypeParam>("hazard");
  const [status, setStatus] = useState<ContentStatusParam>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminContentList({
    type,
    status,
    q: q || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const hideMutation = useHideContent();
  const restoreMutation = useRestoreContent();
  const deleteMutation = useDeleteContent();

  const canDelete = canAccess(currentRole, "admin");
  const rows: ContentItem[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function runMutation(mutate: () => void, id: string) {
    setPendingId(id);
    setActionError(null);
    mutate();
  }

  const columns: ReadonlyArray<DataTableColumn<ContentItem>> = [
    {
      key: "author",
      label: "Author",
      primary: true,
      render: (row) =>
        row.authorId ? (
          <a className="text-link hover:underline" href={`#/users`}>
            {row.authorName ?? row.authorId}
          </a>
        ) : (
          "—"
        ),
    },
    {
      key: "text",
      label: "Text",
      render: (row) => row.text ?? "—",
    },
    {
      key: "photos",
      label: "Photos",
      size: "80px",
      render: (row) =>
        row.photoUrls.length ? String(row.photoUrls.length) : "—",
    },
    {
      key: "status",
      label: "Status",
      size: "110px",
      render: (row) => (
        <Pill variant={row.status === "hidden" ? "danger" : "ghost"}>
          {row.status}
        </Pill>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      render: (row) => row.moderationReason ?? "—",
    },
    {
      key: "actions",
      label: "",
      size: "240px",
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          {row.status === "hidden" ? (
            <Button
              variant="secondary"
              size="sm"
              loading={pendingId === row.id}
              onClick={() =>
                runMutation(
                  () =>
                    restoreMutation.mutate(
                      { params: { path: { type, id: row.id } } },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to restore."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                )
              }
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                const reason =
                  window.prompt("Reason for hiding (optional):") ?? "";
                runMutation(
                  () =>
                    hideMutation.mutate(
                      {
                        params: { path: { type, id: row.id } },
                        body: { reason: reason || null },
                      },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to hide."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                );
              }}
            >
              Hide
            </Button>
          )}
          {canDelete ? (
            <Button
              variant="danger"
              size="sm"
              loading={pendingId === row.id}
              onClick={() => {
                if (!window.confirm("Permanently delete this content?")) return;
                runMutation(
                  () =>
                    deleteMutation.mutate(
                      { params: { path: { type, id: row.id } } },
                      {
                        onSuccess: () => void refetch(),
                        onError: (err: unknown) =>
                          setActionError(
                            readErrorMessage(err, "Failed to delete."),
                          ),
                        onSettled: () => setPendingId(null),
                      },
                    ),
                  row.id,
                );
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section>
      <PageHeader title="Content Moderation" />
      {error ? (
        <Alert
          intent="danger"
          title="Failed to load content."
          className="mb-4"
        />
      ) : null}

      <div className="mb-4 flex gap-2">
        {TYPE_TABS.map((tab) => (
          <Button
            key={tab.key}
            variant={type === tab.key ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setType(tab.key);
              setPage(1);
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Search text"
          ariaLabel="Search content text"
          type="search"
        />
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v as ContentStatusParam);
            setPage(1);
          }}
          ariaLabel="Status filter"
        >
          <option value="all">All</option>
          <option value="visible">Visible</option>
          <option value="hidden">Hidden</option>
        </Select>
      </div>

      {actionError ? (
        <Alert intent="danger" title={actionError} className="mb-4" compact />
      ) : null}

      <DataTable
        columns={columns}
        rows={isPending ? [] : rows}
        rowKey={(row) => row.id}
        showCaret={false}
        emptyState={
          <span className="text-sm text-fg-dim">
            {isPending ? "—" : "No content found."}
          </span>
        }
        ariaLabel="Content moderation"
      />

      <div className="mt-4 flex items-center gap-3 text-sm text-fg-dim">
        <span>
          Page {page} of {totalPages} ({total} total)
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}
```

> NOTE: Confirm the `@tarmoto/ui` `Select` component's prop shape against `UsersScreen.tsx` (lines ~188-220) before finalizing — match its `value`/`onChange`/`ariaLabel` API and option-child convention exactly. If `Select` takes an `options` prop instead of `<option>` children, adapt accordingly.

- [ ] **Step 4: Render the screen in App.tsx**

In `apps/admin/src/app/App.tsx`, add the import:

```typescript
import { ContentScreen } from "../screens/ContentScreen.js";
```

Add a branch in the screen-render ternary, before the `Coming soon` fallback (after the `feature-flags` branch):

```tsx
          ) : active === "feature-flags" ? (
            <FeatureFlagsScreen />
          ) : active === "content" ? (
            <ContentScreen currentRole={currentUser.role} />
          ) : (
```

- [ ] **Step 5: Write the screen test**

Create `apps/admin/src/screens/ContentScreen.test.tsx`. Match the existing admin SPA test harness (check an existing `*.test.tsx` beside it, e.g. `FeatureFlagsScreen.test.tsx` if present, for the render util + `$api` mock approach). The test must cover: rows render from a mocked list hook; the delete control is hidden for `support` and present for `admin`; hide invokes the mutation with the right path + body. Use that file's mocking convention; do not introduce a new test runner.

```tsx
import { render, screen } from "@testing-library/react";
import { ContentScreen } from "./ContentScreen.js";

// Mock the data hooks (mirror the mock style used by the sibling screen tests).
jest.mock("../data/useAdminContent.js", () => ({
  useAdminContentList: () => ({
    data: {
      rows: [
        {
          type: "hazard",
          id: "h1",
          authorId: "u1",
          authorName: "Alice",
          text: "pothole",
          photoUrls: [],
          createdAt: "2026-01-01T00:00:00Z",
          status: "visible",
          moderationReason: null,
          moderatedAt: null,
          location: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    },
    isPending: false,
    error: null,
    refetch: jest.fn(),
  }),
  useHideContent: () => ({ mutate: jest.fn(), isPending: false }),
  useRestoreContent: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteContent: () => ({ mutate: jest.fn(), isPending: false }),
}));

describe("ContentScreen", () => {
  it("renders content rows", () => {
    render(<ContentScreen currentRole="admin" />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("pothole")).toBeInTheDocument();
  });

  it("hides the delete control for support-level admins", () => {
    render(<ContentScreen currentRole="support" />);
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows the delete control for admin-level admins", () => {
    render(<ContentScreen currentRole="admin" />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
```

If the admin SPA test setup differs (e.g. uses a `renderWithProviders` util or a different mock mechanism for `$api`), adapt this file to match the sibling tests exactly.

- [ ] **Step 6: Run the SPA tests + typecheck + build**

Run: `pnpm --filter @tarmoto/admin test` (or the admin test command this repo uses — check `apps/admin/package.json` scripts).
Expected: the three `ContentScreen` cases PASS along with the existing admin SPA suite.

Run: `pnpm --filter @tarmoto/admin build` (or `pnpm --filter @tarmoto/admin exec tsc --noEmit` if a separate typecheck script exists).
Expected: no type errors (the generated `ContentItemDto` and path types resolve).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminContent.ts \
  apps/admin/src/screens/ContentScreen.tsx \
  apps/admin/src/screens/ContentScreen.test.tsx \
  apps/admin/src/app/routes.ts \
  apps/admin/src/app/App.tsx
git commit -m "feat(backend): add admin Content moderation screen"
```

---

## Final verification (after all tasks)

- [ ] Run the full backend suite: `cd apps/backend && npx jest` — expect green (note any pre-existing SIGSEGV flakes, unrelated).
- [ ] Run lint: `pnpm lint` — expect 0 errors.
- [ ] Run the admin SPA suite + build (Task 5 Step 6).
- [ ] Confirm `pnpm openapi:gen` produced no further diff (client is in sync with the DTOs).
- [ ] Manually exercise (optional, if a DB + the app are available): `pnpm dev`, log into the admin SPA on port 3003, open Content, hide a hazard, confirm it leaves the public hazard feed, restore it, confirm it returns; delete as `admin`, confirm it 404s afterward.

## Self-Review notes (coverage vs. spec)

- Spec §4 data model → Task 1 (columns, FK, index, defaults, down()).
- Spec §6 public-feed exclusion → Task 2 (hazards ×2, roads ×3 incl. rating aggregate, reviews list, trip messages) — note the plan covers the roads.service embedded hazard + review queries the design prose did not individually enumerate.
- Spec §5 endpoints + normalized contract → Tasks 3–4 (registry, service, DTOs, controller, gating support/admin, audit target, 400 on unknown type via `ParseEnumPipe`, 404 on missing).
- Spec §5.3 optional Overview metric → Task 4 Step 6-7 (`hiddenContent`).
- Spec §7 authz + privacy → Task 4 (`@AdminRoles`) + Task 5 (`minRole`, `canAccess` delete gate).
- Spec §8 contracts → Task 4 Step 9 (OpenAPI regen); list contract uses `rows` per the existing admin convention (documented deviation from the design's prose `items`).
- Spec §8 tests → service spec (Task 3), controller spec + metric (Task 4), screen spec (Task 5), public-path regression (Task 2).
- Author sanctions remain a link-out (Task 5 author cell → `#/users`), not duplicated — matches the non-goal.
