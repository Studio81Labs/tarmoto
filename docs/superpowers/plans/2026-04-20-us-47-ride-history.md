# US-47 — Ride History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the companion rides list page with a split map + filterable sortable table view, adding backend filters, a tracks endpoint, and a rename endpoint.

**Architecture:** Next.js client page with URL-synced filter state; two fetches (list + simplified tracks); MapLibre GL for the overlay; NestJS filters/sort extension + new `GET /rides/tracks` + `PATCH /rides/:id` endpoints; migration for `rides.name`.

**Tech Stack:** NestJS 11 + TypeORM + PostGIS (backend); Next.js + Tailwind + MapLibre GL 4 (companion); Jest (backend tests); manual verification (companion — no test infra).

**Spec:** [2026-04-20-us-47-ride-history-design.md](../specs/2026-04-20-us-47-ride-history-design.md)

**Running commands:** from the repo root unless noted. Use `pnpm --filter @tarmoto/backend <script>` to scope to the backend workspace.

---

## Phase 1 — Backend schema + ride name

### Task 1: Add `rides.name` column (migration + entity + summary DTO)

**Files:**

- Create: `apps/backend/src/migrations/1713800000000-AddRideName.ts`
- Modify: `apps/backend/src/entities/ride.entity.ts`
- Modify: `apps/backend/src/modules/rides/dto/ride-response.dto.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/modules/rides/rides.service.spec.ts` inside the top-level `describe('RidesService', ...)`, after the existing `start`/`stop` blocks:

```ts
describe("toSummary", () => {
  it("includes name (null when unset)", () => {
    const r = { ...mockRide, name: null } as unknown as Ride;
    expect(service.toSummary(r).name).toBeNull();
  });

  it("includes name when set", () => {
    const r = { ...mockRide, name: "Sunday loop" } as unknown as Ride;
    expect(service.toSummary(r).name).toBe("Sunday loop");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "toSummary"
```

Expected: FAIL — property `name` missing on `RideSummaryDto` / `toSummary` does not copy it.

- [ ] **Step 3: Add the migration**

Create `apps/backend/src/migrations/1713800000000-AddRideName.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * US-47 — user-editable ride name.
 *
 * Nullable — UI falls back to `Ride on <date>` when unset. Populated
 * by the rename endpoint; GPX import may populate it later.
 */
export class AddRideName1713800000000 implements MigrationInterface {
  name = "AddRideName1713800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE rides ADD COLUMN name VARCHAR(120)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE rides DROP COLUMN IF EXISTS name`);
  }
}
```

- [ ] **Step 4: Add the entity column**

In `apps/backend/src/entities/ride.entity.ts`, add a `name` column just after `ride_type`:

```ts
  @Column({ type: 'varchar', length: 120, nullable: true })
  name!: string | null;
```

- [ ] **Step 5: Extend the summary DTO**

In `apps/backend/src/modules/rides/dto/ride-response.dto.ts`, add to `RideSummaryDto` (before `duration_min`):

```ts
  @ApiProperty({ nullable: true })
  name!: string | null;
```

- [ ] **Step 6: Copy `name` in `toSummary`**

In `apps/backend/src/modules/rides/rides.service.ts`, update `toSummary()`:

```ts
  toSummary(ride: Ride): RideSummaryDto {
    return {
      ...this.toRideResponse(ride),
      name: ride.name ?? null,
      duration_min: this.calcDurationMin(ride),
    };
  }
```

- [ ] **Step 7: Run tests — they pass**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec
```

Expected: PASS (new `toSummary` block + all pre-existing tests).

- [ ] **Step 8: Apply the migration against the dev DB**

```bash
pnpm db:migrate
```

Expected: `AddRideName1713800000000` runs with no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/migrations/1713800000000-AddRideName.ts \
        apps/backend/src/entities/ride.entity.ts \
        apps/backend/src/modules/rides/dto/ride-response.dto.ts \
        apps/backend/src/modules/rides/rides.service.ts \
        apps/backend/src/modules/rides/rides.service.spec.ts
git commit -m "feat(backend): add rides.name column (us-47)"
```

---

### Task 2: `PATCH /rides/:id` rename endpoint

**Files:**

- Create: `apps/backend/src/modules/rides/dto/rename-ride.dto.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.spec.ts`
- Modify: `apps/backend/src/modules/rides/rides.controller.ts`
- Modify: `apps/backend/src/modules/rides/rides.controller.spec.ts`

- [ ] **Step 1: Write failing service tests**

Add a new block to `rides.service.spec.ts` inside the top-level describe:

```ts
describe("rename", () => {
  it("updates the name and returns the summary", async () => {
    const existing = { ...mockRide, name: null } as unknown as Ride;
    (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
    (rideRepo.save as jest.Mock).mockImplementationOnce((r) =>
      Promise.resolve(r),
    );

    const result = await service.rename("user-1", "ride-1", "Sunday loop");

    expect(rideRepo.findOne).toHaveBeenCalledWith({
      where: { id: "ride-1", user_id: "user-1" },
    });
    expect(rideRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sunday loop" }),
    );
    expect(result.name).toBe("Sunday loop");
  });

  it("trims whitespace and coerces empty to null", async () => {
    const existing = { ...mockRide, name: "old" } as unknown as Ride;
    (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(existing);
    (rideRepo.save as jest.Mock).mockImplementationOnce((r) =>
      Promise.resolve(r),
    );

    const result = await service.rename("user-1", "ride-1", "   ");

    expect(rideRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: null }),
    );
    expect(result.name).toBeNull();
  });

  it("throws NotFound when ride missing", async () => {
    (rideRepo.findOne as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.rename("user-1", "nope", "x")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "rename"
```

Expected: FAIL — `service.rename` is undefined.

- [ ] **Step 3: Add the DTO**

Create `apps/backend/src/modules/rides/dto/rename-ride.dto.ts`:

```ts
import { IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RenameRideDto {
  @ApiProperty({ nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string | null;
}
```

- [ ] **Step 4: Add the service method**

In `rides.service.ts`, add after the existing `getDetail` method:

```ts
  async rename(
    userId: string,
    rideId: string,
    name: string | null | undefined,
  ): Promise<RideSummaryDto> {
    const ride = await this.rideRepo.findOne({
      where: { id: rideId, user_id: userId },
    });
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    const trimmed = typeof name === 'string' ? name.trim() : '';
    ride.name = trimmed.length > 0 ? trimmed : null;
    const saved = await this.rideRepo.save(ride);
    return this.toSummary(saved);
  }
```

- [ ] **Step 5: Run service tests — they pass**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "rename"
```

Expected: PASS.

- [ ] **Step 6: Write failing controller test**

Add to `rides.controller.spec.ts` after the existing test blocks (extend the `mockService` object to include `rename: jest.fn()`):

```ts
describe("PATCH /rides/:rideId", () => {
  it("calls service.rename with the user and new name", async () => {
    service.rename.mockResolvedValue({
      ...mockRide,
      name: "Renamed",
    } as never);
    const result = await controller.rename(mockReq, "ride-1", {
      name: "Renamed",
    });
    expect(service.rename).toHaveBeenCalledWith("user-1", "ride-1", "Renamed");
    expect(result.name).toBe("Renamed");
  });
});
```

Also add `rename: jest.fn()` to the `mockService` initializer in `beforeEach`.

- [ ] **Step 7: Verify controller test fails**

```bash
pnpm --filter @tarmoto/backend test -- rides.controller.spec -t "PATCH /rides/:rideId"
```

Expected: FAIL — `controller.rename` not defined.

- [ ] **Step 8: Add the controller method**

In `rides.controller.ts`:

1. Add to the imports at the top: add `Patch`, `ParseUUIDPipe`, `Body` if missing (check existing imports).
2. Add `RenameRideDto` import: `import { RenameRideDto } from './dto/rename-ride.dto.js';`
3. Add to the `RideSummaryDto` import line if missing (already imported — verify).
4. Add the endpoint method. Place it AFTER the `exportAll*` literal-path endpoints but BEFORE any `@Get(':rideId')`/`@Post(':rideId/*)` to keep Nest's route ordering happy:

```ts
  @Patch(':rideId')
  @ApiOperation({ summary: 'Rename a ride' })
  @ApiResponse({ status: 200, type: RideSummaryDto })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async rename(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: RenameRideDto,
  ): Promise<RideSummaryDto> {
    return this.ridesService.rename(req.user!.userId, rideId, dto.name ?? null);
  }
```

- [ ] **Step 9: Run all tests — they pass**

```bash
pnpm --filter @tarmoto/backend test -- rides
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/modules/rides
git commit -m "feat(backend): add rides rename endpoint (us-47)"
```

---

## Phase 2 — Backend list filters and sort

### Task 3: Extend `GET /rides` with filter and sort params

**Files:**

- Modify: `apps/backend/src/modules/rides/dto/list-rides.dto.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.spec.ts`

- [ ] **Step 1: Write failing service tests**

Replace the `mockRide` `createQueryBuilder` stub with a version that captures `andWhere`/`orderBy` calls. At the top of `rides.service.spec.ts`, add a helper:

```ts
function makeQbSpy() {
  const andWhere = jest.fn().mockReturnThis();
  const orderBy = jest.fn().mockReturnThis();
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere,
    orderBy,
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return { qb, andWhere, orderBy };
}
```

Add a new test block:

```ts
describe("list filters and sort", () => {
  it("applies date, distance, quality, type, and search filters", async () => {
    const { qb, andWhere } = makeQbSpy();
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await service.list("user-1", {
      started_from: "2026-01-01",
      started_to: "2026-04-20",
      min_distance_km: 10,
      max_distance_km: 500,
      min_quality: 2,
      max_quality: 5,
      type: "trip",
      q: "sunday",
    } as never);

    const predicates = andWhere.mock.calls.map((c) => c[0] as string);
    expect(predicates).toEqual(
      expect.arrayContaining([
        expect.stringContaining("started_at >="),
        expect.stringContaining("started_at <"),
        expect.stringContaining("distance_km >="),
        expect.stringContaining("distance_km <="),
        expect.stringContaining("avg_road_quality >="),
        expect.stringContaining("avg_road_quality <="),
        expect.stringContaining("ride_type ="),
        expect.stringContaining("name ILIKE"),
      ]),
    );
  });

  it("sorts by distance_km asc when requested", async () => {
    const { qb, orderBy } = makeQbSpy();
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await service.list("user-1", {
      sort: "distance_km",
      order: "asc",
    } as never);

    expect(orderBy).toHaveBeenCalledWith("ride.distance_km", "ASC");
  });

  it("defaults sort to started_at DESC", async () => {
    const { qb, orderBy } = makeQbSpy();
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await service.list("user-1", {} as never);

    expect(orderBy).toHaveBeenCalledWith("ride.started_at", "DESC");
  });
});
```

- [ ] **Step 2: Verify they fail**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "list filters and sort"
```

Expected: FAIL — new filter/sort params unused.

- [ ] **Step 3: Extend the DTO**

Replace `apps/backend/src/modules/rides/dto/list-rides.dto.ts`:

```ts
import {
  IsOptional,
  IsString,
  IsInt,
  IsIn,
  Min,
  Max,
  IsISO8601,
  IsNumber,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

const SORTABLE = [
  "started_at",
  "distance_km",
  "duration_min",
  "avg_road_quality",
] as const;
export type RidesSortField = (typeof SORTABLE)[number];

export class ListRidesDto {
  @ApiProperty({ default: 20, required: false, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({ default: 0, required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiProperty({
    required: false,
    enum: ["free", "commute", "trip", "tracked"],
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ required: false, description: "ISO 8601 date (inclusive)" })
  @IsOptional()
  @IsISO8601()
  started_from?: string;

  @ApiProperty({
    required: false,
    description: "ISO 8601 date (inclusive end-of-day)",
  })
  @IsOptional()
  @IsISO8601()
  started_to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(0)
  min_distance_km?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(0)
  max_distance_km?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(5)
  min_quality?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(1)
  @Max(5)
  max_quality?: number;

  @ApiProperty({
    required: false,
    description: "Case-insensitive substring match against ride name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiProperty({ required: false, enum: SORTABLE })
  @IsOptional()
  @IsIn(SORTABLE as unknown as string[])
  sort?: RidesSortField;

  @ApiProperty({ required: false, enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  order?: "asc" | "desc";
}
```

- [ ] **Step 4: Extend `RidesService.list()`**

Replace the body of `list()` in `rides.service.ts`:

```ts
  async list(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideListResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const qb = this.rideRepo
      .createQueryBuilder('ride')
      .where('ride.user_id = :userId', { userId })
      .skip(offset)
      .take(limit);

    if (query.type) {
      qb.andWhere('ride.ride_type = :type', { type: query.type });
    }
    if (query.started_from) {
      qb.andWhere('ride.started_at >= :started_from', {
        started_from: query.started_from,
      });
    }
    if (query.started_to) {
      // inclusive end-of-day — add one day, compare with <
      const to = new Date(query.started_to);
      to.setUTCDate(to.getUTCDate() + 1);
      qb.andWhere('ride.started_at < :started_to_excl', {
        started_to_excl: to.toISOString(),
      });
    }
    if (query.min_distance_km !== undefined) {
      qb.andWhere('ride.distance_km >= :min_distance_km', {
        min_distance_km: query.min_distance_km,
      });
    }
    if (query.max_distance_km !== undefined) {
      qb.andWhere('ride.distance_km <= :max_distance_km', {
        max_distance_km: query.max_distance_km,
      });
    }
    if (query.min_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality >= :min_quality', {
        min_quality: query.min_quality,
      });
    }
    if (query.max_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality <= :max_quality', {
        max_quality: query.max_quality,
      });
    }
    if (query.q) {
      qb.andWhere('ride.name ILIKE :q', { q: `%${query.q}%` });
    }

    const sortField = query.sort ?? 'started_at';
    const order = (query.order ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
    // duration_min is derived (ended_at - started_at); sort via started_at as
    // a proxy when sort=duration_min is requested — ride lengths in minutes
    // aren't stored on the ride row, so DB-side sort by the literal field
    // isn't available without a computed column. Spec calls this out as
    // acceptable for v1.
    const column =
      sortField === 'duration_min' ? 'started_at' : sortField;
    qb.orderBy(`ride.${column}`, order);

    const [rides, total] = await qb.getManyAndCount();

    return {
      rides: rides.map((r) => this.toSummary(r)),
      total,
    };
  }
```

- [ ] **Step 5: Run the tests — they pass**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec
```

Expected: PASS (new `list filters and sort` block + all pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/rides
git commit -m "feat(backend): list rides filters and sort (us-47)"
```

---

## Phase 3 — Backend tracks endpoint

### Task 4: `GET /rides/tracks`

**Files:**

- Modify: `apps/backend/src/modules/rides/dto/ride-response.dto.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.spec.ts`
- Modify: `apps/backend/src/modules/rides/rides.controller.ts`
- Modify: `apps/backend/src/modules/rides/rides.controller.spec.ts`

- [ ] **Step 1: Add response DTOs**

In `apps/backend/src/modules/rides/dto/ride-response.dto.ts`, append:

```ts
export class RideTrackDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: "object", nullable: true, additionalProperties: true })
  geometry!: { type: "LineString"; coordinates: number[][] } | null;
}

export class RideTracksResponseDto {
  @ApiProperty({ type: [RideTrackDto] })
  tracks!: RideTrackDto[];

  @ApiProperty({ description: "true when the 500-row cap was hit" })
  truncated!: boolean;
}
```

- [ ] **Step 2: Write failing service tests**

Add to `rides.service.spec.ts`:

```ts
describe("getTracks", () => {
  function makeTracksQbSpy(
    rows: Array<{ id: string; geometry: string | null }>,
    count: number,
  ) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
      getCount: jest.fn().mockResolvedValue(count),
    };
    return qb;
  }

  it("returns simplified GeoJSON geometries and truncated=false below cap", async () => {
    const qb = makeTracksQbSpy(
      [
        {
          id: "r1",
          geometry: JSON.stringify({
            type: "LineString",
            coordinates: [
              [14, 50],
              [14.1, 50.1],
            ],
          }),
        },
      ],
      1,
    );
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    const res = await service.getTracks("user-1", {} as never);

    expect(res.tracks).toEqual([
      {
        id: "r1",
        geometry: {
          type: "LineString",
          coordinates: [
            [14, 50],
            [14.1, 50.1],
          ],
        },
      },
    ]);
    expect(res.truncated).toBe(false);
  });

  it("sets truncated=true when more than 500 rides match", async () => {
    const qb = makeTracksQbSpy([], 501);
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    const res = await service.getTracks("user-1", {} as never);
    expect(res.truncated).toBe(true);
  });

  it("excludes null-geometry rides at query level", async () => {
    const qb = makeTracksQbSpy([], 0);
    (rideRepo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

    await service.getTracks("user-1", {} as never);

    const predicates = (qb.andWhere as jest.Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(predicates).toEqual(
      expect.arrayContaining([
        expect.stringContaining("route_geom IS NOT NULL"),
      ]),
    );
  });
});
```

- [ ] **Step 3: Verify they fail**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "getTracks"
```

Expected: FAIL — `service.getTracks` undefined.

- [ ] **Step 4: Add the service method**

In `rides.service.ts`, add after `rename()`:

```ts
  async getTracks(
    userId: string,
    query: ListRidesDto,
  ): Promise<RideTracksResponseDto> {
    const CAP = 500;
    const SIMPLIFY_TOLERANCE_DEG = 0.0005; // ~50 m at mid-latitudes

    const qb = this.rideRepo
      .createQueryBuilder('ride')
      .select('ride.id', 'id')
      .addSelect(
        `ST_AsGeoJSON(ST_SimplifyPreserveTopology(ride.route_geom, ${SIMPLIFY_TOLERANCE_DEG}))`,
        'geometry',
      )
      .where('ride.user_id = :userId', { userId })
      .andWhere('ride.route_geom IS NOT NULL');

    // Filter parity with list() — DRY by extracting a helper if this grows.
    if (query.type) {
      qb.andWhere('ride.ride_type = :type', { type: query.type });
    }
    if (query.started_from) {
      qb.andWhere('ride.started_at >= :started_from', {
        started_from: query.started_from,
      });
    }
    if (query.started_to) {
      const to = new Date(query.started_to);
      to.setUTCDate(to.getUTCDate() + 1);
      qb.andWhere('ride.started_at < :started_to_excl', {
        started_to_excl: to.toISOString(),
      });
    }
    if (query.min_distance_km !== undefined) {
      qb.andWhere('ride.distance_km >= :min_distance_km', {
        min_distance_km: query.min_distance_km,
      });
    }
    if (query.max_distance_km !== undefined) {
      qb.andWhere('ride.distance_km <= :max_distance_km', {
        max_distance_km: query.max_distance_km,
      });
    }
    if (query.min_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality >= :min_quality', {
        min_quality: query.min_quality,
      });
    }
    if (query.max_quality !== undefined) {
      qb.andWhere('ride.avg_road_quality <= :max_quality', {
        max_quality: query.max_quality,
      });
    }
    if (query.q) {
      qb.andWhere('ride.name ILIKE :q', { q: `%${query.q}%` });
    }

    const [rows, totalMatching] = await Promise.all([
      qb
        .orderBy('ride.started_at', 'DESC')
        .limit(CAP)
        .getRawMany<{ id: string; geometry: string | null }>(),
      qb.getCount(),
    ]);

    const tracks = rows.map((r) => ({
      id: r.id,
      geometry: r.geometry
        ? (JSON.parse(r.geometry) as {
            type: 'LineString';
            coordinates: number[][];
          })
        : null,
    }));

    return { tracks, truncated: totalMatching > CAP };
  }
```

Also ensure the import at the top of `rides.service.ts` covers `RideTracksResponseDto`:

```ts
import {
  RideResponseDto,
  RideSummaryDto,
  RideDetailDto,
  RideListResponseDto,
  RideTracksResponseDto,
} from "./dto/ride-response.dto.js";
```

- [ ] **Step 5: Run service tests — they pass**

```bash
pnpm --filter @tarmoto/backend test -- rides.service.spec -t "getTracks"
```

Expected: PASS.

- [ ] **Step 6: Write failing controller test**

In `rides.controller.spec.ts`, add to `mockService` in the `beforeEach`:

```ts
      getTracks: jest
        .fn()
        .mockResolvedValue({ tracks: [], truncated: false }),
```

Add a new describe block after the existing ones:

```ts
describe("GET /rides/tracks", () => {
  it("forwards the user and filters to the service", async () => {
    const result = await controller.tracks(mockReq, {
      type: "trip",
    } as never);
    expect(service.getTracks).toHaveBeenCalledWith("user-1", { type: "trip" });
    expect(result.truncated).toBe(false);
  });
});
```

- [ ] **Step 7: Verify it fails**

```bash
pnpm --filter @tarmoto/backend test -- rides.controller.spec -t "GET /rides/tracks"
```

Expected: FAIL — `controller.tracks` undefined.

- [ ] **Step 8: Add the controller method**

In `rides.controller.ts`, add `RideTracksResponseDto` to the DTO import block, then add this method BEFORE the `@Get(':rideId')` route (and before any `@Patch(':rideId')`) so the literal `tracks` path wins Nest's matching — e.g. right after the `exportAllGpx` method:

```ts
  @Get('tracks')
  @ApiOperation({
    summary: 'List simplified track geometries for map overlay',
  })
  @ApiResponse({ status: 200, type: RideTracksResponseDto })
  async tracks(
    @Req() req: express.Request,
    @Query() query: ListRidesDto,
  ): Promise<RideTracksResponseDto> {
    return this.ridesService.getTracks(req.user!.userId, query);
  }
```

- [ ] **Step 9: Run all backend tests — they pass**

```bash
pnpm --filter @tarmoto/backend test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/modules/rides
git commit -m "feat(backend): rides tracks endpoint for map overlay (us-47)"
```

---

## Phase 4 — Regenerate OpenAPI types

### Task 5: Regenerate OpenAPI spec and companion types

**Files:**

- Regen: `packages/openapi/openapi.yaml` + `packages/openapi/types.ts`

- [ ] **Step 1: Build the backend and regenerate**

```bash
pnpm --filter @tarmoto/openapi generate
```

Expected: script exits 0; `packages/openapi/openapi.yaml` and `packages/openapi/types.ts` are updated to include the new `name` field, filter/sort params, `PATCH /rides/{rideId}`, and `GET /rides/tracks`.

- [ ] **Step 2: Typecheck companion**

```bash
pnpm --filter @tarmoto/companion typecheck
```

Expected: PASS (no regressions).

- [ ] **Step 3: Run all tests once more**

```bash
pnpm -w test
```

Expected: PASS across workspaces.

- [ ] **Step 4: Commit**

```bash
git add packages/openapi/openapi.yaml packages/openapi/types.ts
git commit -m "chore(openapi): regen for rides filters, rename, tracks (us-47)"
```

---

## Phase 5 — Companion split view page

### Task 6: Data hook — URL-synced filters + two fetches

**Files:**

- Create: `apps/companion/src/app/(dashboard)/rides/_components/useRidesQuery.ts`

- [ ] **Step 1: Create the hook**

Create `apps/companion/src/app/(dashboard)/rides/_components/useRidesQuery.ts`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

export type SortField =
  "started_at" | "distance_km" | "duration_min" | "avg_road_quality";
export type SortOrder = "asc" | "desc";

export interface RidesFilters {
  from?: string; // ISO date, YYYY-MM-DD
  to?: string;
  minDistance?: number;
  maxDistance?: number;
  minQuality?: number;
  maxQuality?: number;
  q?: string;
  type?: string;
}

export interface RidesQueryState extends RidesFilters {
  sort: SortField;
  order: SortOrder;
  page: number; // 1-based
}

const PAGE_SIZE = 20;

export function parseQuery(params: URLSearchParams): RidesQueryState {
  const num = (k: string) => {
    const v = params.get(k);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) => params.get(k) || undefined;

  const sortRaw = str("sort");
  const sort: SortField =
    sortRaw === "distance_km" ||
    sortRaw === "duration_min" ||
    sortRaw === "avg_road_quality"
      ? sortRaw
      : "started_at";
  const orderRaw = str("order");
  const order: SortOrder = orderRaw === "asc" ? "asc" : "desc";
  const pageNum = Math.max(1, Math.floor(num("page") ?? 1));

  return {
    from: str("from"),
    to: str("to"),
    minDistance: num("minDist"),
    maxDistance: num("maxDist"),
    minQuality: num("minQ"),
    maxQuality: num("maxQ"),
    q: str("q"),
    type: str("type"),
    sort,
    order,
    page: pageNum,
  };
}

export function serializeQuery(state: Partial<RidesQueryState>): string {
  const u = new URLSearchParams();
  if (state.from) u.set("from", state.from);
  if (state.to) u.set("to", state.to);
  if (state.minDistance != null) u.set("minDist", String(state.minDistance));
  if (state.maxDistance != null) u.set("maxDist", String(state.maxDistance));
  if (state.minQuality != null) u.set("minQ", String(state.minQuality));
  if (state.maxQuality != null) u.set("maxQ", String(state.maxQuality));
  if (state.q) u.set("q", state.q);
  if (state.type) u.set("type", state.type);
  if (state.sort && state.sort !== "started_at") u.set("sort", state.sort);
  if (state.order && state.order !== "desc") u.set("order", state.order);
  if (state.page && state.page !== 1) u.set("page", String(state.page));
  return u.toString();
}

function toListParams(s: RidesQueryState): Record<string, string | number> {
  const p: Record<string, string | number> = {
    limit: PAGE_SIZE,
    offset: (s.page - 1) * PAGE_SIZE,
    sort: s.sort,
    order: s.order,
  };
  if (s.from) p.started_from = s.from;
  if (s.to) p.started_to = s.to;
  if (s.minDistance != null) p.min_distance_km = s.minDistance;
  if (s.maxDistance != null) p.max_distance_km = s.maxDistance;
  if (s.minQuality != null) p.min_quality = s.minQuality;
  if (s.maxQuality != null) p.max_quality = s.maxQuality;
  if (s.q) p.q = s.q;
  if (s.type) p.type = s.type;
  return p;
}

function toTracksParams(s: RidesQueryState): Record<string, string | number> {
  // Same filters as list, minus pagination/sort.
  const {
    limit: _l,
    offset: _o,
    sort: _s,
    order: _ord,
    ...rest
  } = toListParams(s);
  void _l;
  void _o;
  void _s;
  void _ord;
  return rest;
}

export interface RideSummary {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  ride_type: string;
  status: string;
  distance_km: number | null;
  avg_speed: number | null;
  avg_road_quality: number | null;
  duration_min: number | null;
}

export interface RideTrack {
  id: string;
  geometry: { type: "LineString"; coordinates: number[][] } | null;
}

interface ListResult {
  rides: RideSummary[];
  total: number;
  loading: boolean;
  error: string | null;
}

interface TracksResult {
  tracks: RideTrack[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export function useRidesQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => parseQuery(params), [params]);

  // ── list fetch ──
  const [list, setList] = useState<ListResult>({
    rides: [],
    total: 0,
    loading: true,
    error: null,
  });
  useEffect(() => {
    const ctrl = new AbortController();
    setList((s) => ({ ...s, loading: true, error: null }));
    api
      .GET("/api/v1/rides", {
        params: { query: toListParams(state) as never },
        signal: ctrl.signal,
      })
      .then(({ data, error }) => {
        if (ctrl.signal.aborted) return;
        if (error) {
          setList({
            rides: [],
            total: 0,
            loading: false,
            error: "Failed to load rides",
          });
          return;
        }
        const d = data as unknown as { rides: RideSummary[]; total: number };
        setList({
          rides: d.rides ?? [],
          total: d.total ?? 0,
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setList({
          rides: [],
          total: 0,
          loading: false,
          error: err.message,
        });
      });
    return () => ctrl.abort();
  }, [state]);

  // ── tracks fetch (debounced on filter changes) ──
  const [tracks, setTracks] = useState<TracksResult>({
    tracks: [],
    truncated: false,
    loading: true,
    error: null,
  });
  const tracksKey = useMemo(
    () => JSON.stringify(toTracksParams(state)),
    [state],
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const ctrl = new AbortController();
    setTracks((s) => ({ ...s, loading: true, error: null }));
    debounceRef.current = setTimeout(() => {
      api
        .GET("/api/v1/rides/tracks", {
          params: { query: toTracksParams(state) as never },
          signal: ctrl.signal,
        })
        .then(({ data, error }) => {
          if (ctrl.signal.aborted) return;
          if (error) {
            setTracks({
              tracks: [],
              truncated: false,
              loading: false,
              error: "Failed to load tracks",
            });
            return;
          }
          const d = data as unknown as {
            tracks: RideTrack[];
            truncated: boolean;
          };
          setTracks({
            tracks: d.tracks ?? [],
            truncated: !!d.truncated,
            loading: false,
            error: null,
          });
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted) return;
          setTracks({
            tracks: [],
            truncated: false,
            loading: false,
            error: err.message,
          });
        });
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      ctrl.abort();
    };
    // Re-run on any filter change (not just object identity).
  }, [tracksKey, state]);

  function update(patch: Partial<RidesQueryState>) {
    // Any filter change (anything other than page/sort/order) resets page to 1.
    const isFilterChange = Object.keys(patch).some(
      (k) => k !== "page" && k !== "sort" && k !== "order",
    );
    const next: RidesQueryState = {
      ...state,
      ...patch,
      page: isFilterChange ? 1 : (patch.page ?? state.page),
    };
    const qs = serializeQuery(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function reset() {
    router.replace(pathname, { scroll: false });
  }

  return { state, list, tracks, update, reset, pageSize: PAGE_SIZE };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tarmoto/companion typecheck
```

Expected: PASS. If the openapi client's exact param typing complains about the generated query shape, leave the existing `as never` casts — we're matching the pre-existing `data as unknown as Ride[]` pattern from the current page.

- [ ] **Step 3: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/rides/_components/useRidesQuery.ts
git commit -m "feat(companion): rides history data hook (us-47)"
```

---

### Task 7: Filters component

**Files:**

- Create: `apps/companion/src/app/(dashboard)/rides/_components/RidesFilters.tsx`

- [ ] **Step 1: Create the component**

Create `apps/companion/src/app/(dashboard)/rides/_components/RidesFilters.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import type { RidesQueryState } from "./useRidesQuery";

const RIDE_TYPES = ["free", "commute", "trip", "tracked"] as const;

interface Props {
  state: RidesQueryState;
  update: (patch: Partial<RidesQueryState>) => void;
  reset: () => void;
}

export function RidesFilters({ state, update, reset }: Props) {
  // Local state for the search box — debounced before writing to URL.
  const [searchLocal, setSearchLocal] = useState(state.q ?? "");
  useEffect(() => {
    setSearchLocal(state.q ?? "");
  }, [state.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((state.q ?? "") !== searchLocal) {
        update({ q: searchLocal || undefined });
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchLocal]);

  const hasAny = Boolean(
    state.from ||
    state.to ||
    state.minDistance != null ||
    state.maxDistance != null ||
    state.minQuality != null ||
    state.maxQuality != null ||
    state.q ||
    state.type,
  );

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          From
          <input
            type="date"
            value={state.from ?? ""}
            onChange={(e) => update({ from: e.target.value || undefined })}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          To
          <input
            type="date"
            value={state.to ?? ""}
            onChange={(e) => update({ to: e.target.value || undefined })}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          Min km
          <input
            type="number"
            min={0}
            value={state.minDistance ?? ""}
            onChange={(e) =>
              update({
                minDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="text-xs text-slate-400 flex flex-col gap-1">
          Max km
          <input
            type="number"
            min={0}
            value={state.maxDistance ?? ""}
            onChange={(e) =>
              update({
                maxDistance:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Quality (min → max)</span>
          <div className="flex items-center gap-2">
            <select
              value={state.minQuality ?? ""}
              onChange={(e) =>
                update({
                  minQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-slate-500">–</span>
            <select
              value={state.maxQuality ?? ""}
              onChange={(e) =>
                update({
                  maxQuality:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">Type</span>
          <div className="flex flex-wrap gap-1">
            <TypeChip
              label="All"
              active={!state.type}
              onClick={() => update({ type: undefined })}
            />
            {RIDE_TYPES.map((t) => (
              <TypeChip
                key={t}
                label={t}
                active={state.type === t}
                onClick={() => update({ type: t })}
              />
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 flex-1 min-w-[180px]">
          <span className="text-xs text-slate-400">Search name</span>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="search"
              value={searchLocal}
              onChange={(e) => setSearchLocal(e.target.value)}
              placeholder="Sunday…"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-2 py-1.5 text-sm text-slate-100"
            />
          </div>
        </label>

        {hasAny && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 transition"
          >
            <RotateCcw size={14} /> Reset
          </button>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs transition ${
        active
          ? "bg-tarmoto-cyan text-slate-900"
          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tarmoto/companion typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/rides/_components/RidesFilters.tsx
git commit -m "feat(companion): rides history filters (us-47)"
```

---

### Task 8: Table and row components

**Files:**

- Create: `apps/companion/src/app/(dashboard)/rides/_components/RideRow.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/_components/RidesTable.tsx`

- [ ] **Step 1: Create `RideRow.tsx`**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";
import type { RideSummary } from "./useRidesQuery";

interface Props {
  ride: RideSummary;
  selected: boolean;
  onSelect: () => void;
  onRenamed: (next: RideSummary) => void;
}

const QUALITY_COLOR: Record<number, string> = {
  5: "bg-emerald-500/20 text-emerald-300",
  4: "bg-lime-500/20 text-lime-300",
  3: "bg-yellow-500/20 text-yellow-300",
  2: "bg-orange-500/20 text-orange-300",
  1: "bg-red-500/20 text-red-300",
};

function qualityBand(q: number | null): number | null {
  if (q == null) return null;
  return Math.min(5, Math.max(1, Math.round(q)));
}

export function RideRow({ ride, selected, onSelect, onRenamed }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ride.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    setDraft(ride.name ?? "");
  }, [ride.name]);

  useEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const trimmed = draft.trim();
    try {
      const { data, error } = await api.PATCH("/api/v1/rides/{rideId}", {
        params: { path: { rideId: ride.id } },
        body: { name: trimmed === "" ? null : trimmed },
      } as never);
      if (error) throw new Error("Rename failed");
      const d = data as unknown as RideSummary;
      onRenamed(d);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }

  const q = qualityBand(ride.avg_road_quality);
  const displayName =
    ride.name ?? `Ride on ${new Date(ride.started_at).toLocaleDateString()}`;

  return (
    <tr
      ref={rowRef}
      onClick={onSelect}
      className={`cursor-pointer transition ${
        selected
          ? "bg-slate-800/60 border-l-2 border-tarmoto-cyan"
          : "hover:bg-slate-800/40 border-l-2 border-transparent"
      }`}
    >
      <td className="px-3 py-2">
        {editing ? (
          <div
            className="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") {
                  setDraft(ride.name ?? "");
                  setEditing(false);
                }
              }}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              aria-label="Save"
              className="p-1 text-emerald-400 hover:bg-slate-700 rounded"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(ride.name ?? "");
                setEditing(false);
              }}
              aria-label="Cancel"
              className="p-1 text-slate-400 hover:bg-slate-700 rounded"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="group flex items-center gap-1.5 text-left"
          >
            <span className="truncate text-slate-100">{displayName}</span>
            <Pencil
              size={12}
              className="text-slate-500 opacity-0 group-hover:opacity-100 transition"
            />
          </button>
        )}
        {error && <p className="text-xs text-red-400 mt-0.5">{error}</p>}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {new Date(ride.started_at).toLocaleDateString()}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {ride.distance_km != null ? `${ride.distance_km.toFixed(1)} km` : "—"}
      </td>
      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
        {ride.duration_min != null ? `${ride.duration_min} min` : "—"}
      </td>
      <td className="px-3 py-2">
        {q != null ? (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${QUALITY_COLOR[q]}`}
          >
            {ride.avg_road_quality?.toFixed(1)}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Create `RidesTable.tsx`**

```tsx
"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { RideRow } from "./RideRow";
import type { RideSummary, RidesQueryState, SortField } from "./useRidesQuery";

interface Props {
  state: RidesQueryState;
  rides: RideSummary[];
  total: number;
  pageSize: number;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSort: (sort: SortField) => void;
  onPage: (page: number) => void;
  onRenamed: (next: RideSummary) => void;
}

const COLUMNS: Array<{ key: SortField | null; label: string }> = [
  { key: null, label: "Name" },
  { key: "started_at", label: "Date" },
  { key: "distance_km", label: "Distance" },
  { key: "duration_min", label: "Duration" },
  { key: "avg_road_quality", label: "Avg quality" },
];

export function RidesTable({
  state,
  rides,
  total,
  pageSize,
  loading,
  selectedId,
  onSelect,
  onSort,
  onPage,
  onRenamed,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden flex flex-col min-h-0">
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wide sticky top-0">
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key && state.sort === col.key;
                return (
                  <th
                    key={col.label}
                    className="px-3 py-2 text-left font-medium"
                  >
                    {col.key ? (
                      <button
                        type="button"
                        onClick={() => onSort(col.key as SortField)}
                        className="inline-flex items-center gap-1 hover:text-slate-200"
                      >
                        {col.label}
                        {active &&
                          (state.order === "asc" ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rides.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td colSpan={5} className="px-3 py-3">
                    <div className="h-5 bg-slate-800 rounded" />
                  </td>
                </tr>
              ))
            ) : rides.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-slate-500"
                >
                  No rides match these filters.
                </td>
              </tr>
            ) : (
              rides.map((r) => (
                <RideRow
                  key={r.id}
                  ride={r}
                  selected={selectedId === r.id}
                  onSelect={() => onSelect(r.id)}
                  onRenamed={onRenamed}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800 text-sm text-slate-400">
        <span>
          {total === 0 ? "0 rides" : `${total} ride${total === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPage(state.page - 1)}
            disabled={state.page <= 1}
            aria-label="Previous page"
            className="p-1 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            Page {state.page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPage(state.page + 1)}
            disabled={state.page >= totalPages}
            aria-label="Next page"
            className="p-1 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tarmoto/companion typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/rides/_components/RideRow.tsx \
        apps/companion/src/app/\(dashboard\)/rides/_components/RidesTable.tsx
git commit -m "feat(companion): rides history table with rename (us-47)"
```

---

### Task 9: Map component (MapLibre)

**Files:**

- Modify: `apps/companion/src/lib/config.ts` (add `MAP_STYLE_URL`)
- Create: `apps/companion/src/app/(dashboard)/rides/_components/RidesMap.tsx`

- [ ] **Step 1: Add a map style URL constant**

In `apps/companion/src/lib/config.ts`, append:

```ts
/**
 * MapLibre style URL. Until INFRA #79 lands with the custom Tarmoto style
 * and tile pipeline, we use OpenFreeMap's free public Liberty style.
 * Override via NEXT_PUBLIC_MAP_STYLE_URL for staging/branding work.
 */
export const MAP_STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ??
  "https://tiles.openfreemap.org/styles/liberty";
```

- [ ] **Step 2: Create `RidesMap.tsx`**

```tsx
"use client";

import { useEffect, useRef } from "react";
import maplibregl, {
  type LngLatBoundsLike,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MAP_STYLE_URL } from "@/lib/config";
import type { RideTrack } from "./useRidesQuery";

interface Props {
  tracks: RideTrack[];
  truncated: boolean;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const SOURCE_ID = "rides-tracks";
const LAYER_ID = "rides-tracks-line";
const DEFAULT_CENTER: [number, number] = [14.4378, 50.0755]; // Prague

export function RidesMap({
  tracks,
  truncated,
  loading,
  selectedId,
  onSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const hoverRef = useRef<string | null>(null);
  const fittedOnceRef = useRef(false);

  // ── init map once ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: DEFAULT_CENTER,
      zoom: 6,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            "#22d3ee", // cyan-400
            ["boolean", ["feature-state", "hover"], false],
            "#22d3ee",
            "#64748b", // slate-500
          ],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            4,
            ["boolean", ["feature-state", "hover"], false],
            3,
            2,
          ],
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            ["boolean", ["feature-state", "hover"], false],
            0.9,
            0.6,
          ],
        },
      });

      map.on("click", LAYER_ID, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f?.properties?.id) return;
        onSelect(String(f.properties.id));
      });
      map.on("mouseenter", LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mousemove", LAYER_ID, (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (!id) return;
        if (hoverRef.current && hoverRef.current !== id) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoverRef.current },
            { hover: false },
          );
        }
        hoverRef.current = id;
        map.setFeatureState({ source: SOURCE_ID, id }, { hover: true });
      });
      map.on("mouseleave", LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
        if (hoverRef.current) {
          map.setFeatureState(
            { source: SOURCE_ID, id: hoverRef.current },
            { hover: false },
          );
          hoverRef.current = null;
        }
      });

      ready.current = true;
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      ready.current = false;
      fittedOnceRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── push tracks → source ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const src = map.getSource(SOURCE_ID) as
      maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const features = tracks
      .filter((t) => t.geometry)
      .map((t) => ({
        type: "Feature" as const,
        id: t.id,
        properties: { id: t.id },
        geometry: t.geometry!,
      }));
    src.setData({ type: "FeatureCollection", features });

    // Fit to bounds once on first non-empty payload, then preserve the user's
    // view on subsequent filter changes.
    if (!fittedOnceRef.current && features.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const f of features) {
        for (const c of f.geometry.coordinates) {
          bounds.extend([c[0], c[1]]);
        }
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds as LngLatBoundsLike, {
          padding: 40,
          duration: 0,
        });
      }
      fittedOnceRef.current = true;
    }
  }, [tracks]);

  // ── reflect selection via feature-state + fly-to ──
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const prev = selectedRef.current;
    if (prev && prev !== selectedId) {
      map.setFeatureState({ source: SOURCE_ID, id: prev }, { selected: false });
    }
    if (selectedId) {
      map.setFeatureState(
        { source: SOURCE_ID, id: selectedId },
        { selected: true },
      );
      const t = tracks.find((x) => x.id === selectedId);
      if (t?.geometry?.coordinates.length) {
        const bounds = new maplibregl.LngLatBounds();
        for (const c of t.geometry.coordinates) {
          bounds.extend([c[0], c[1]]);
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds as LngLatBoundsLike, {
            padding: 60,
            maxZoom: 14,
            duration: 600,
          });
        }
      }
    }
    selectedRef.current = selectedId;
  }, [selectedId, tracks]);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-slate-800">
      <div ref={containerRef} className="absolute inset-0" />
      {loading && (
        <div className="absolute top-2 right-2 rounded-full bg-slate-900/80 border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
          Loading…
        </div>
      )}
      {truncated && (
        <div className="absolute bottom-2 left-2 rounded-lg bg-slate-900/90 border border-amber-600/50 px-3 py-1.5 text-xs text-amber-200 max-w-[320px]">
          Showing most recent 500 rides — refine filters to narrow the map.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tarmoto/companion typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/companion/src/lib/config.ts \
        apps/companion/src/app/\(dashboard\)/rides/_components/RidesMap.tsx
git commit -m "feat(companion): rides history map overlay (us-47)"
```

---

### Task 10: Assemble the split-view page

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/page.tsx`

- [ ] **Step 1: Replace the page**

Replace the entire contents of `apps/companion/src/app/(dashboard)/rides/page.tsx`:

```tsx
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Download,
  List as ListIcon,
  Loader2,
  Map as MapIcon,
  Scale,
} from "lucide-react";
import {
  downloadAllRidesExport,
  type RideExportFormat,
} from "@/lib/ride-export";
import { RidesFilters } from "./_components/RidesFilters";
import { RidesMap } from "./_components/RidesMap";
import { RidesTable } from "./_components/RidesTable";
import {
  useRidesQuery,
  type RideSummary,
  type SortField,
} from "./_components/useRidesQuery";

export default function RidesPage() {
  // useSearchParams needs a Suspense boundary for Next.js static optimization.
  return (
    <Suspense fallback={null}>
      <RidesPageInner />
    </Suspense>
  );
}

function RidesPageInner() {
  const { state, list, tracks, update, reset, pageSize } = useRidesQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"map" | "list">("list");

  // Optimistic updates after rename — merge into the current list snapshot.
  const [patched, setPatched] = useState<Record<string, RideSummary>>({});
  useEffect(() => {
    setPatched({});
  }, [list.rides]);
  const mergedRides = list.rides.map((r) => patched[r.id] ?? r);

  function onSort(sort: SortField) {
    if (state.sort === sort) {
      update({ order: state.order === "asc" ? "desc" : "asc" });
    } else {
      update({ sort, order: "desc" });
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] p-4 md:p-6 max-w-7xl mx-auto w-full animate-fade-in">
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Ride History</h1>
        <div className="flex items-center gap-2">
          {list.rides.length > 0 && <BulkExportMenu />}
          {list.total >= 2 && (
            <Link
              href="/rides/compare"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 transition"
            >
              <Scale size={14} /> Compare rides
            </Link>
          )}
        </div>
      </div>

      <RidesFilters state={state} update={update} reset={reset} />

      {/* Mobile tab toggle */}
      <div className="flex md:hidden items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 mb-3 w-fit">
        <button
          type="button"
          onClick={() => setMobileTab("map")}
          className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm ${
            mobileTab === "map"
              ? "bg-slate-800 text-slate-100"
              : "text-slate-400"
          }`}
        >
          <MapIcon size={14} /> Map
        </button>
        <button
          type="button"
          onClick={() => setMobileTab("list")}
          className={`flex items-center gap-1 px-3 py-1 rounded-md text-sm ${
            mobileTab === "list"
              ? "bg-slate-800 text-slate-100"
              : "text-slate-400"
          }`}
        >
          <ListIcon size={14} /> List
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 flex-1 min-h-0">
        <div
          className={`md:col-span-3 min-h-[360px] md:min-h-0 ${
            mobileTab === "map" ? "" : "hidden md:block"
          }`}
        >
          <RidesMap
            tracks={tracks.tracks}
            truncated={tracks.truncated}
            loading={tracks.loading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </div>
        <div
          className={`md:col-span-2 min-h-0 flex flex-col ${
            mobileTab === "list" ? "" : "hidden md:flex"
          }`}
        >
          <RidesTable
            state={state}
            rides={mergedRides}
            total={list.total}
            pageSize={pageSize}
            loading={list.loading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onSort={onSort}
            onPage={(page) => update({ page })}
            onRenamed={(next) =>
              setPatched((prev) => ({ ...prev, [next.id]: next }))
            }
          />
          {list.error && (
            <p className="text-xs text-red-400 mt-2">{list.error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BulkExportMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RideExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      if (!containerRef.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function handleExport(format: RideExportFormat) {
    if (busy) return;
    setBusy(format);
    setError(null);
    try {
      await downloadAllRidesExport(format);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Download size={14} />
        )}
        Export all
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-44 rounded-lg bg-slate-900 border border-slate-800 shadow-lg overflow-hidden z-10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            CSV (stats)
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("gpx")}
            disabled={busy !== null}
            className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition border-t border-slate-800"
          >
            GPX (tracks)
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full mt-2 text-xs text-red-400 whitespace-nowrap"
        >
          Export failed: {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

```bash
pnpm --filter @tarmoto/companion typecheck
pnpm --filter @tarmoto/companion lint
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/companion/src/app/\(dashboard\)/rides/page.tsx
git commit -m "feat(companion): rides history split view page (us-47)"
```

---

## Phase 6 — Verification

### Task 11: Manual verification + follow-up issue

**Files:** none — verification + issue filing only.

- [ ] **Step 1: Bring up dependencies**

```bash
pnpm db:up
pnpm db:migrate
```

Expected: Postgres + Redis running; migrations (including `AddRideName`) applied.

- [ ] **Step 2: Start backend and companion**

In two terminals:

```bash
pnpm dev:backend
```

```bash
pnpm dev:companion
```

- [ ] **Step 3: Seed rides for verification**

Option A — use existing rides if the dev DB already has ≥20 rides for your account. Check via:

```bash
psql $TARMOTO_DATABASE_URL -c "SELECT COUNT(*) FROM rides WHERE user_id = '<your-user-id>';"
```

Option B — import GPX files via the existing `/rides/import` endpoint from the companion or mobile dev build until you have at least 20 rides spanning multiple dates, distances, and quality scores. If your dev DB has a seed script under `apps/backend/src/seeds`, run it: `pnpm --filter @tarmoto/backend seed:rides` (skip if the script doesn't exist; the backfill path is acceptable).

- [ ] **Step 4: Walk each acceptance criterion**

Log in to the companion, navigate to `/rides`, and verify:

1. **Map view — all ride tracks overlaid, click to select** — tracks render; clicking a track highlights it in cyan and scrolls the matching table row into view.
2. **List view — sortable table** — each of `Date`, `Distance`, `Duration`, `Avg quality` headers toggles sort; URL updates with `sort` and `order`; the rides reorder. Default is `started_at` desc.
3. **Filter by date range, distance, road quality** — each filter narrows both the map and the list. The URL reflects the filters.
4. **Search by ride name** — typing into the search box narrows results after ~300 ms debounce.
5. **Pagination** — prev/next disabled at boundaries; page number reflects in URL; switching page does not lose filters.
6. **Rename** — click a ride's name, type a new name, press Enter; the row and map selection update; refreshing the page shows the new name.
7. **Mobile** — narrow the browser to < 768 px; confirm the Map/List tab toggle appears and switches correctly.
8. **Empty state** — apply a filter that matches nothing; confirm the "No rides match these filters" empty state plus reset.
9. **Truncation** — if you have > 500 matching rides, confirm the "showing most recent 500" amber banner appears on the map.

- [ ] **Step 5: Run all tests one last time**

```bash
pnpm -w test
pnpm --filter @tarmoto/companion typecheck
pnpm --filter @tarmoto/companion lint
```

Expected: PASS.

- [ ] **Step 6: File the location-search follow-up issue**

```bash
gh issue create \
  --title "US-47 follow-up: location-based ride search (passes near <place>)" \
  --label "type:feature,platform:web,phase:mvp-2,epic:web-ride-history" \
  --body "$(cat <<'BODY'
Follow-up to #59.

The US-47 design deliberately scoped ride search to ride name only; location search ("passes near <place>") was carved off because it requires geocoding infrastructure not present in the codebase today.

**Scope:**
- Choose a geocoding provider (Mapbox/Nominatim/Pelias) — ADR-worthy decision.
- Add `GET /api/v1/geocode?q=` (proxied) or let the companion call the provider directly.
- Extend `GET /api/v1/rides` and `GET /api/v1/rides/tracks` with `near_lat`, `near_lng`, `near_km` params; apply `ST_DWithin(route_geom, ST_MakePoint(lng, lat)::geography, near_km * 1000)`.
- Update the search input on `/rides` to accept a place name, geocode, and merge with existing filters.

**Dependencies:**
- US-47 (#59) shipped.
BODY
)"
```

- [ ] **Step 7: Commit verification notes to the PR (no code commit needed)**

Open the PR when you open it; include the verification walkthrough results in the PR description.

---

## Self-review checklist

Done by the plan author (not by the engineer executing the plan):

- [x] **Spec coverage** — every spec section has at least one task:
  - Route/page structure → Task 10
  - URL as source of truth → Task 6
  - Backend `name` column + DTO + `toSummary` → Task 1
  - `PATCH /rides/:id` → Task 2
  - Extended `ListRidesDto` + filters/sort → Task 3
  - `GET /rides/tracks` → Task 4
  - OpenAPI regen → Task 5
  - Data hook (list + tracks, debounce) → Task 6
  - Filters component → Task 7
  - Table with rename + pagination + sort → Task 8
  - Map with feature-state selection + fit-bounds-once + truncation banner → Task 9
  - Mobile tab toggle + split desktop layout → Task 10
  - Manual verification → Task 11
  - Location-search follow-up filed → Task 11
- [x] **Placeholder scan** — no TBD/TODO/"appropriate"/"similar to"/`<fill in>`; every step has concrete code or command.
- [x] **Type consistency** — `RidesQueryState`, `RideSummary`, `RideTrack`, `SortField`, `SortOrder` are defined once in Task 6 and consumed identically by Tasks 7–10. Backend `toSummary` includes `name` (Task 1) and is consumed by rename (Task 2) and list (Task 3). `RideTracksResponseDto` defined in Task 4 and imported by the controller in the same task. `MAP_STYLE_URL` added to `config.ts` in Task 9 before it's imported.

---

**Plan complete.**

**Plan saved to:** `docs/superpowers/plans/2026-04-20-us-47-ride-history.md`

### Execution options

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with two-stage review between tasks. Best for isolated-task execution and keeping each commit reviewable.
2. **Inline Execution** — I run tasks directly in this session via superpowers:executing-plans, with checkpoints for you to review.

Which approach?
