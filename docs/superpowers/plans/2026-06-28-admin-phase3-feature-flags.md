# Admin Phase 3 — Feature Flags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators create / toggle / delete boolean feature flags in the admin console; clients read them from a public config endpoint.

**Architecture:** A new `feature_flags` table (entity + hand-written migration) backs an admin CRUD surface (`apps/backend/src/modules/admin-flags/`, registered in the existing `AdminModule` so the global `InternalGuard` + `AdminAuditInterceptor` apply) and a public read endpoint (`apps/backend/src/modules/config/`, registered in `AppModule`, no auth guard). A shared `FeatureFlagMap` type + helper serve non-SPA consumers; a new SPA screen drives the CRUD.

**Tech Stack:** NestJS 11, TypeORM (raw-SQL migrations), `@nestjs/swagger`, `class-validator`, Jest (backend); `@nestjs/throttler` (global), Vite + React 19 + `openapi-react-query` + `@tarmoto/ui`, Vitest (admin SPA).

## Global Constraints

- **TypeScript strict.** Backend ESM imports use explicit `.js` extensions. Admin SPA local imports also use `.js`. Shared re-exports use NO extension (`export * from "./feature-flags"`).
- **Booleans only; free-form runtime keys; global on/off.** No typed value column, NO fixed flag-key enum in `@tarmoto/shared`, no rollout targeting.
- **`key` format:** `^[a-z][a-z0-9_]*$`, ≤128 chars, **unique**, **immutable** after create (PATCH never changes `key`).
- **Backend global prefix `api/v1`** — the SPA calls prefixed paths `/api/v1/admin/flags`; the client endpoint is `/api/v1/config/flags`.
- **Admin flags surface:** all routes `@AdminRoles('admin')`; mutations call `setAdminAuditTarget(req, { target_type: 'feature_flag', target_id })`. The audit interceptor auto-records mutating `/admin/*` calls.
- **Client `/config/flags`:** public (no `@UseGuards`), returns `Record<string, boolean>` of all flags, `@Header('Cache-Control', 'public, max-age=60')`. Keep default throttling (do NOT `@SkipThrottle`).
- **Migration is hand-written raw SQL** and MUST be registered in BOTH `apps/backend/src/data-source.ts` (CLI; guarded by `migration-registry.spec.ts`) AND `apps/backend/src/modules/database/database.module.ts` (runtime). The `FeatureFlag` entity must be registered in BOTH entity lists too (+ `entities/index.ts` barrel if it exists).
- **No silent fallbacks:** invalid key → 400, duplicate key → 409, not-found → 404, each with a clear message.
- **Commands:** single backend test `pnpm --filter @tarmoto/backend test -- --testPathPatterns=<pat>` (Jest 30, plural flag); single admin test `pnpm --filter @tarmoto/admin test -- <pat>`; `pnpm shared:build`; `pnpm openapi:gen`; `pnpm --filter @tarmoto/backend lint`; `pnpm --filter @tarmoto/admin lint`.
- **Conventional commits**, scope `backend` for backend, `cross` for SPA + cross-cutting, `shared` for the shared package only. (NOT `admin` — commitlint rejects it.)

---

## File Structure

**Backend**

- `apps/backend/src/entities/feature-flag.entity.ts` — the `feature_flags` entity.
- `apps/backend/src/migrations/1782000000000-AddFeatureFlags.ts` — create table + unique index.
- `apps/backend/src/modules/admin-flags/dto/admin-flags.dto.ts` — DTOs.
- `apps/backend/src/modules/admin-flags/admin-flags.service.ts` — list/create/update/delete.
- `apps/backend/src/modules/admin-flags/admin-flags.controller.ts` — `@Controller('admin')` routes.
- `apps/backend/src/modules/config/config.service.ts` — flat-map read.
- `apps/backend/src/modules/config/config.controller.ts` — public `GET /config/flags`.
- `apps/backend/src/modules/config/config.module.ts`.
- Modify: `data-source.ts`, `database.module.ts`, `entities/index.ts` (if present) — register entity + migration; `admin.module.ts` — register controller/service/entity; `admin-metrics.service.ts` — wire the count; `app.module.ts` — register `ConfigModule`.

**Shared**

- `packages/shared/src/feature-flags.ts` — `FeatureFlagMap` + `isFeatureEnabled`.
- Modify: `packages/shared/src/index.ts` — re-export.

**Admin SPA**

- `apps/admin/src/data/useAdminFlags.ts` — `$api` hooks.
- `apps/admin/src/screens/FeatureFlagsScreen.tsx`.
- Modify: `apps/admin/src/app/routes.ts` (set `minRole: 'admin'`), `apps/admin/src/app/App.tsx` (render the screen).

---

## Task 1: Backend — FeatureFlag entity + migration + shared type/helper

**Files:**

- Create: `apps/backend/src/entities/feature-flag.entity.ts`
- Create: `apps/backend/src/migrations/1782000000000-AddFeatureFlags.ts`
- Create: `packages/shared/src/feature-flags.ts`
- Test: `packages/shared/src/feature-flags.spec.ts` (or the shared package's test location — match the existing shared test pattern)
- Modify: `apps/backend/src/data-source.ts`, `apps/backend/src/modules/database/database.module.ts`, `apps/backend/src/entities/index.ts` (only if it exists), `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `FeatureFlag` entity (`id`, `key`, `enabled`, `description`, `created_at`, `updated_at`); `FeatureFlagMap = Record<string, boolean>`; `isFeatureEnabled(map: FeatureFlagMap, key: string, fallback?: boolean): boolean`.

- [ ] **Step 1: Write the entity**

Create `apps/backend/src/entities/feature-flag.entity.ts`:

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("feature_flags")
@Index("uq_feature_flags_key", ["key"], { unique: true })
export class FeatureFlag {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  key!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  @Column({ type: "varchar", length: 500, nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}
```

- [ ] **Step 2: Write the migration**

First confirm the timestamp is greater than every existing migration: `ls apps/backend/src/migrations/`. If any existing file has a numeric prefix ≥ `1782000000000`, bump this one above it. Create `apps/backend/src/migrations/1782000000000-AddFeatureFlags.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFeatureFlags1782000000000 implements MigrationInterface {
  name = "AddFeatureFlags1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE feature_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(128) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        description VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_feature_flags_key ON feature_flags (key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS feature_flags CASCADE;`);
  }
}
```

- [ ] **Step 3: Register the entity + migration in BOTH lists**

In `apps/backend/src/data-source.ts`: import `FeatureFlag` and add it to the `entities` array; import `AddFeatureFlags1782000000000` and add it to the `migrations` array.
In `apps/backend/src/modules/database/database.module.ts`: add `FeatureFlag` to its `entities` array and `AddFeatureFlags1782000000000` to its `migrations` array (this is the authoritative runtime list — `migrationsRun: true`).
If `apps/backend/src/entities/index.ts` exists as a barrel, add `export * from './feature-flag.entity.js';` (check first; skip if no barrel).

- [ ] **Step 4: Run the migration-registry test + backend build (expect pass)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=migration-registry`
Expected: PASS (the new migration is now in `data-source.ts`).
Run: `pnpm --filter @tarmoto/backend build`
Expected: compiles (entity + migration typecheck).

- [ ] **Step 5: Write the failing shared helper test**

Match the shared package's existing test setup (check `packages/shared` for an existing `*.spec.ts` + its jest/vitest config; mirror it). Create the test (shown for Jest-style; adapt to the shared runner):

```typescript
import { isFeatureEnabled, type FeatureFlagMap } from "./feature-flags";

describe("isFeatureEnabled", () => {
  const flags: FeatureFlagMap = { group_rides: true, beta_ui: false };

  it("returns the flag value when present", () => {
    expect(isFeatureEnabled(flags, "group_rides")).toBe(true);
    expect(isFeatureEnabled(flags, "beta_ui")).toBe(false);
  });

  it("returns the fallback (default false) for an unknown key", () => {
    expect(isFeatureEnabled(flags, "missing")).toBe(false);
    expect(isFeatureEnabled(flags, "missing", true)).toBe(true);
  });
});
```

- [ ] **Step 6: Run it (expect fail)**

Run the shared package test (e.g. `pnpm --filter @tarmoto/shared test`).
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the shared module + re-export**

Create `packages/shared/src/feature-flags.ts`:

```typescript
/**
 * A flat map of feature-flag key → enabled. Mirrors the response of
 * GET /api/v1/config/flags. Keys are free-form (created by operators at
 * runtime), so this is intentionally not a fixed union.
 */
export type FeatureFlagMap = Record<string, boolean>;

/**
 * Read a feature flag safely. Returns `fallback` (default false) when the
 * key is absent, so a missing/disabled flag never enables a feature.
 */
export function isFeatureEnabled(
  flags: FeatureFlagMap,
  key: string,
  fallback = false,
): boolean {
  return flags[key] ?? fallback;
}
```

Add to `packages/shared/src/index.ts`: `export * from "./feature-flags";`

- [ ] **Step 8: Run the shared test + build (expect pass)**

Run the shared test → PASS. Then `pnpm shared:build` → succeeds (so the type is available to backend + admin).

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/entities/feature-flag.entity.ts apps/backend/src/migrations/1782000000000-AddFeatureFlags.ts apps/backend/src/data-source.ts apps/backend/src/modules/database/database.module.ts packages/shared/src/feature-flags.ts packages/shared/src/feature-flags.spec.ts packages/shared/src/index.ts
# include apps/backend/src/entities/index.ts only if it was modified
git commit -m "feat(backend): add feature_flags entity, migration, and shared FeatureFlagMap"
```

---

## Task 2: Backend — admin flags DTOs + service

**Files:**

- Create: `apps/backend/src/modules/admin-flags/dto/admin-flags.dto.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-flags.service.ts`
- Test: `apps/backend/src/modules/admin-flags/admin-flags.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureFlag` entity (Task 1).
- Produces: `AdminFlagsService` with `list(): Promise<FeatureFlagDto[]>`, `create(dto: CreateFeatureFlagDto): Promise<FeatureFlagDto>`, `update(id, dto: UpdateFeatureFlagDto): Promise<FeatureFlagDto>`, `remove(id): Promise<void>`. DTOs: `CreateFeatureFlagDto`, `UpdateFeatureFlagDto`, `FeatureFlagDto`.

- [ ] **Step 1: Write the DTOs**

Create `apps/backend/src/modules/admin-flags/dto/admin-flags.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

export const FEATURE_FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export class CreateFeatureFlagDto {
  @ApiProperty({
    description: "Unique flag key (lowercase snake_case).",
    example: "group_rides",
  })
  @IsString()
  @MaxLength(128)
  @Matches(FEATURE_FLAG_KEY_PATTERN, {
    message: "key must be lowercase snake_case matching ^[a-z][a-z0-9_]*$",
  })
  key!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateFeatureFlagDto {
  @ApiPropertyOptional({ description: "Toggle the flag." })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class FeatureFlagDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() created_at!: string;
  @ApiProperty() updated_at!: string;
}
```

> `key` validation lives in `CreateFeatureFlagDto` (DTOs are validated by the global `ValidationPipe`), so invalid keys → 400 before the service runs. `UpdateFeatureFlagDto` has NO `key` field — key is immutable.

- [ ] **Step 2: Write the failing service test**

Create `apps/backend/src/modules/admin-flags/admin-flags.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from "@nestjs/common";
import { AdminFlagsService } from "./admin-flags.service.js";

const ROW = {
  id: "f1",
  key: "group_rides",
  enabled: false,
  description: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    find: jest.fn().mockResolvedValue([ROW]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((v: object) => ({ ...ROW, ...v })),
    save: jest
      .fn()
      .mockImplementation((v: object) => Promise.resolve({ ...ROW, ...v })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...over,
  };
}

describe("AdminFlagsService", () => {
  it("list() returns mapped rows ordered by key", async () => {
    const repo = makeRepo();
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.list();
    expect(res[0]).toMatchObject({
      id: "f1",
      key: "group_rides",
      enabled: false,
    });
    expect(repo.find).toHaveBeenCalledWith({ order: { key: "ASC" } });
  });

  it("create() inserts a new flag", async () => {
    const repo = makeRepo();
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.create({ key: "beta_ui", enabled: true });
    expect(res).toMatchObject({ key: "beta_ui", enabled: true });
    expect(repo.save).toHaveBeenCalled();
  });

  it("create() throws Conflict on a duplicate key (pre-check)", async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(ROW) });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.create({ key: "group_rides" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("create() maps a unique-violation (23505) race to Conflict", async () => {
    const repo = makeRepo({
      save: jest.fn().mockRejectedValue({ code: "23505" }),
    });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.create({ key: "group_rides" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("update() changes enabled/description and returns the row", async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(ROW) });
    const svc = new AdminFlagsService(repo as never);
    const res = await svc.update("f1", { enabled: true });
    expect(repo.update).toHaveBeenCalledWith({ id: "f1" }, { enabled: true });
    expect(res.enabled).toBe(true);
  });

  it("update() throws NotFound for an unknown id", async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(null) });
    const svc = new AdminFlagsService(repo as never);
    await expect(svc.update("nope", { enabled: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("remove() deletes; NotFound when nothing deleted", async () => {
    const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(ROW) });
    const svc = new AdminFlagsService(repo as never);
    await svc.remove("f1");
    expect(repo.delete).toHaveBeenCalledWith({ id: "f1" });

    const repo2 = makeRepo({ findOne: jest.fn().mockResolvedValue(null) });
    const svc2 = new AdminFlagsService(repo2 as never);
    await expect(svc2.remove("nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 3: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-flags.service`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the service**

Create `apps/backend/src/modules/admin-flags/admin-flags.service.ts`:

```typescript
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { FeatureFlag } from "../../entities/feature-flag.entity.js";
import {
  CreateFeatureFlagDto,
  FeatureFlagDto,
  UpdateFeatureFlagDto,
} from "./dto/admin-flags.dto.js";

@Injectable()
export class AdminFlagsService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
  ) {}

  async list(): Promise<FeatureFlagDto[]> {
    const rows = await this.flags.find({ order: { key: "ASC" } });
    return rows.map((r) => this.toDto(r));
  }

  async create(dto: CreateFeatureFlagDto): Promise<FeatureFlagDto> {
    const existing = await this.flags.findOne({ where: { key: dto.key } });
    if (existing) {
      throw new ConflictException("A flag with this key already exists");
    }
    const entity = this.flags.create({
      key: dto.key,
      enabled: dto.enabled ?? false,
      description: dto.description ?? null,
    });
    try {
      const saved = await this.flags.save(entity);
      return this.toDto(saved);
    } catch (err) {
      // Race backstop: the unique index caught a concurrent insert.
      if ((err as { code?: string })?.code === "23505") {
        throw new ConflictException("A flag with this key already exists");
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateFeatureFlagDto): Promise<FeatureFlagDto> {
    const existing = await this.flags.findOne({ where: { id } });
    if (!existing) throw new NotFoundException("Flag not found");

    const patch: Partial<FeatureFlag> = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.description !== undefined) patch.description = dto.description;
    if (Object.keys(patch).length > 0) {
      await this.flags.update({ id }, patch);
    }
    const updated = await this.flags.findOne({ where: { id } });
    return this.toDto(updated!);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.flags.findOne({ where: { id } });
    if (!existing) throw new NotFoundException("Flag not found");
    await this.flags.delete({ id });
  }

  private toDto(r: FeatureFlag): FeatureFlagDto {
    return {
      id: r.id,
      key: r.key,
      enabled: r.enabled,
      description: r.description,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }
}
```

- [ ] **Step 5: Run the test (expect pass)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-flags.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-flags
git commit -m "feat(backend): add admin feature-flags service + DTOs"
```

---

## Task 3: Backend — admin flags controller + module wiring + Overview metric + OpenAPI

**Files:**

- Create: `apps/backend/src/modules/admin-flags/admin-flags.controller.ts`
- Test: `apps/backend/src/modules/admin-flags/admin-flags.controller.spec.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`, `apps/backend/src/modules/admin/admin-metrics.service.ts`
- Modify (generated): `packages/openapi-client/src/generated/schema.d.ts`

**Interfaces:**

- Consumes: `AdminFlagsService` (Task 2); `AdminRequest` (`../admin/internal.guard.js`); `setAdminAuditTarget` (`../admin/admin-audit-context.js`); `FeatureFlag` (for metrics).
- Produces: routes `GET /admin/flags`, `POST /admin/flags`, `PATCH /admin/flags/:id`, `DELETE /admin/flags/:id`, all `@AdminRoles('admin')`.

- [ ] **Step 1: Write the failing controller test**

Create `apps/backend/src/modules/admin-flags/admin-flags.controller.spec.ts`:

```typescript
import type { AdminRequest } from "../admin/internal.guard.js";
import { AdminFlagsController } from "./admin-flags.controller.js";
import { AdminFlagsService } from "./admin-flags.service.js";

describe("AdminFlagsController", () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "f1" }),
    update: jest.fn().mockResolvedValue({ id: "f1" }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminFlagsService>;
  const controller = new AdminFlagsController(service);
  const req = {} as unknown as AdminRequest;

  it("GET /admin/flags lists", async () => {
    await controller.list();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.list).toHaveBeenCalled();
  });

  it("POST /admin/flags creates + sets audit target", async () => {
    await controller.create(req, { key: "beta_ui" });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalledWith({ key: "beta_ui" });
  });

  it("PATCH /admin/flags/:id updates", async () => {
    await controller.update(req, "f1", { enabled: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.update).toHaveBeenCalledWith("f1", { enabled: true });
  });

  it("DELETE /admin/flags/:id removes", async () => {
    await controller.remove(req, "f1");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.remove).toHaveBeenCalledWith("f1");
  });
});
```

- [ ] **Step 2: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-flags.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the controller**

Create `apps/backend/src/modules/admin-flags/admin-flags.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminRoles } from "../admin-auth/admin-role.decorator.js";
import type { AdminRequest } from "../admin/internal.guard.js";
import { setAdminAuditTarget } from "../admin/admin-audit-context.js";
import { AdminFlagsService } from "./admin-flags.service.js";
import {
  CreateFeatureFlagDto,
  FeatureFlagDto,
  UpdateFeatureFlagDto,
} from "./dto/admin-flags.dto.js";

@ApiTags("admin")
@Controller("admin")
export class AdminFlagsController {
  constructor(private readonly service: AdminFlagsService) {}

  @Get("flags")
  @AdminRoles("admin")
  @ApiOperation({ summary: "List feature flags" })
  @ApiResponse({ status: 200, type: [FeatureFlagDto] })
  list(): Promise<FeatureFlagDto[]> {
    return this.service.list();
  }

  @Post("flags")
  @AdminRoles("admin")
  @ApiOperation({ summary: "Create a feature flag" })
  @ApiResponse({ status: 201, type: FeatureFlagDto })
  async create(
    @Req() req: AdminRequest,
    @Body() dto: CreateFeatureFlagDto,
  ): Promise<FeatureFlagDto> {
    const flag = await this.service.create(dto);
    setAdminAuditTarget(req, {
      target_type: "feature_flag",
      target_id: flag.id,
    });
    return flag;
  }

  @Patch("flags/:id")
  @AdminRoles("admin")
  @ApiOperation({ summary: "Update a feature flag (enabled / description)" })
  @ApiResponse({ status: 200, type: FeatureFlagDto })
  async update(
    @Req() req: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeatureFlagDto,
  ): Promise<FeatureFlagDto> {
    setAdminAuditTarget(req, { target_type: "feature_flag", target_id: id });
    return this.service.update(id, dto);
  }

  @Delete("flags/:id")
  @AdminRoles("admin")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a feature flag" })
  async remove(
    @Req() req: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    setAdminAuditTarget(req, { target_type: "feature_flag", target_id: id });
    return this.service.remove(id);
  }
}
```

- [ ] **Step 4: Register in AdminModule**

In `apps/backend/src/modules/admin/admin.module.ts`: add `FeatureFlag` to `TypeOrmModule.forFeature([...])`, `AdminFlagsController` to `controllers`, `AdminFlagsService` to `providers`. Import all with `.js`.

- [ ] **Step 5: Wire the Overview metric**

In `apps/backend/src/modules/admin/admin-metrics.service.ts`: import `FeatureFlag`; add `@InjectRepository(FeatureFlag) private readonly flags: Repository<FeatureFlag>` to the constructor; in `snapshot()` add `this.flags.count()` to the `Promise.all` and return it as `featureFlags`:

```typescript
const [users, closures, activeRides, featureFlags] = await Promise.all([
  this.users.count({ where: { deleted_at: IsNull() } }),
  this.closures.count(),
  this.rides.count({ where: { status: "active" } }),
  this.flags.count(),
]);
return { users, activeRides, featureFlags, closures };
```

`FeatureFlag` is already in `AdminModule`'s `forFeature` (Step 4), so the repo injects.

- [ ] **Step 6: Run controller test + full suite**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-flags.controller` → PASS.
Run: `pnpm --filter @tarmoto/backend test` → full suite green.
Run: `pnpm --filter @tarmoto/backend lint` → 0 errors (ignore pre-existing events.gateway warnings).

- [ ] **Step 7: Regenerate the OpenAPI client**

Run: `pnpm openapi:gen`
Expected: `schema.d.ts` contains `/api/v1/admin/flags` and `/api/v1/admin/flags/{id}`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/admin-flags/admin-flags.controller.ts apps/backend/src/modules/admin-flags/admin-flags.controller.spec.ts apps/backend/src/modules/admin/admin.module.ts apps/backend/src/modules/admin/admin-metrics.service.ts packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): expose admin feature-flags endpoints (admin+) and wire overview metric"
```

---

## Task 4: Backend — public client config endpoint

**Files:**

- Create: `apps/backend/src/modules/config/config.service.ts`
- Create: `apps/backend/src/modules/config/config.controller.ts`
- Create: `apps/backend/src/modules/config/config.module.ts`
- Test: `apps/backend/src/modules/config/config.service.spec.ts`, `apps/backend/src/modules/config/config.controller.spec.ts`
- Modify: `apps/backend/src/app.module.ts` (register `ConfigModule`), `packages/openapi-client/src/generated/schema.d.ts`

**Interfaces:**

- Consumes: `FeatureFlag` entity; `FeatureFlagMap` from `@tarmoto/shared`.
- Produces: `GET /config/flags` → `FeatureFlagMap` (`Record<string, boolean>`), public, cache header.

- [ ] **Step 1: Write the failing service test**

Create `apps/backend/src/modules/config/config.service.spec.ts`:

```typescript
import { ConfigService } from "./config.service.js";

describe("ConfigService", () => {
  it("flags() returns a flat key→enabled map", async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([
        { key: "group_rides", enabled: true },
        { key: "beta_ui", enabled: false },
      ]),
    };
    const svc = new ConfigService(repo as never);
    await expect(svc.flags()).resolves.toEqual({
      group_rides: true,
      beta_ui: false,
    });
    expect(repo.find).toHaveBeenCalledWith({
      select: { key: true, enabled: true },
    });
  });
});
```

- [ ] **Step 2: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=config.service`
Expected: FAIL.

- [ ] **Step 3: Implement the service**

Create `apps/backend/src/modules/config/config.service.ts`:

```typescript
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { FeatureFlagMap } from "@tarmoto/shared";
import { FeatureFlag } from "../../entities/feature-flag.entity.js";

@Injectable()
export class ConfigService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
  ) {}

  async flags(): Promise<FeatureFlagMap> {
    const rows = await this.flags.find({
      select: { key: true, enabled: true },
    });
    return rows.reduce<FeatureFlagMap>((acc, r) => {
      acc[r.key] = r.enabled;
      return acc;
    }, {});
  }
}
```

- [ ] **Step 4: Write the failing controller test**

Create `apps/backend/src/modules/config/config.controller.spec.ts`:

```typescript
import { ConfigController } from "./config.controller.js";
import { ConfigService } from "./config.service.js";

describe("ConfigController", () => {
  it("GET /config/flags returns the map", async () => {
    const service = {
      flags: jest.fn().mockResolvedValue({ group_rides: true }),
    } as unknown as jest.Mocked<ConfigService>;
    const controller = new ConfigController(service);
    await expect(controller.flags()).resolves.toEqual({ group_rides: true });
  });
});
```

- [ ] **Step 5: Run it (expect fail), then implement controller + module**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=config.controller` → FAIL.

Create `apps/backend/src/modules/config/config.controller.ts`:

```typescript
import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FeatureFlagMap } from "@tarmoto/shared";
import { ConfigService } from "./config.service.js";

@ApiTags("config")
@Controller("config")
export class ConfigController {
  constructor(private readonly service: ConfigService) {}

  @Get("flags")
  @Header("Cache-Control", "public, max-age=60")
  @ApiOperation({ summary: "Public feature-flag map (key → enabled)" })
  @ApiResponse({
    status: 200,
    schema: { type: "object", additionalProperties: { type: "boolean" } },
  })
  flags(): Promise<FeatureFlagMap> {
    return this.service.flags();
  }
}
```

Create `apps/backend/src/modules/config/config.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FeatureFlag } from "../../entities/feature-flag.entity.js";
import { ConfigController } from "./config.controller.js";
import { ConfigService } from "./config.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([FeatureFlag])],
  controllers: [ConfigController],
  providers: [ConfigService],
})
export class ConfigModule {}
```

> The controller has NO `@UseGuards` → public. The endpoint sits under the global `api/v1` prefix → `/api/v1/config/flags`. The `InternalGuard` (admin) only governs `/admin/*`, so this passes through. The global throttler still applies (do NOT `@SkipThrottle`).
> NOTE: NestJS already has a built-in `@nestjs/config` `ConfigModule`. If the backend imports that anywhere, alias this import (`import { ConfigModule as FeatureConfigModule }`) or name this class `AppConfigModule` to avoid a clash — check `app.module.ts` imports before naming. If there is no `@nestjs/config` usage, `ConfigModule` is fine.

- [ ] **Step 6: Register in AppModule**

In `apps/backend/src/app.module.ts`: import the new module and add it to the `imports` array (alongside the other feature modules like `BikesModule`).

- [ ] **Step 7: Run tests + full suite + OpenAPI**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=config` → PASS.
Run: `pnpm --filter @tarmoto/backend test` → green. `pnpm --filter @tarmoto/backend lint` → 0 errors.
Run: `pnpm openapi:gen` → `schema.d.ts` contains `/api/v1/config/flags`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/config apps/backend/src/app.module.ts packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): add public GET /config/flags client read endpoint"
```

---

## Task 5: SPA — Feature Flags screen

**Files:**

- Create: `apps/admin/src/data/useAdminFlags.ts`
- Create: `apps/admin/src/screens/FeatureFlagsScreen.tsx`
- Test: `apps/admin/src/screens/FeatureFlagsScreen.test.tsx`
- Modify: `apps/admin/src/app/routes.ts`, `apps/admin/src/app/App.tsx`

**Interfaces:**

- Consumes: `$api` (`../data/apiClient.js`); the regenerated `/api/v1/admin/flags` paths; `components['schemas']['FeatureFlagDto']`.
- Produces: `useAdminFlagsList`, `useCreateFlag`, `useUpdateFlag`, `useDeleteFlag`; `FeatureFlagsScreen`.

- [ ] **Step 1: Implement the hooks**

Create `apps/admin/src/data/useAdminFlags.ts`:

```typescript
import { $api } from "./apiClient.js";

export function useAdminFlagsList() {
  return $api.useQuery("get", "/api/v1/admin/flags");
}
export function useCreateFlag() {
  return $api.useMutation("post", "/api/v1/admin/flags");
}
export function useUpdateFlag() {
  return $api.useMutation("patch", "/api/v1/admin/flags/{id}");
}
export function useDeleteFlag() {
  return $api.useMutation("delete", "/api/v1/admin/flags/{id}");
}
```

- [ ] **Step 2: Write the failing screen test**

Create `apps/admin/src/screens/FeatureFlagsScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureFlagsScreen } from "./FeatureFlagsScreen.js";

const mockUpdate = vi.fn();
const mockRefetch = vi.fn();

vi.mock("../data/useAdminFlags.js", () => ({
  useAdminFlagsList: () => ({
    data: [
      {
        id: "f1",
        key: "group_rides",
        enabled: false,
        description: "Group ride tools",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    isPending: false,
    error: null,
    refetch: mockRefetch,
  }),
  useCreateFlag: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateFlag: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteFlag: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("FeatureFlagsScreen", () => {
  it("renders the flag rows", () => {
    render(<FeatureFlagsScreen />);
    expect(screen.getByText("group_rides")).toBeInTheDocument();
  });

  it("toggling a flag calls update with the negated enabled", async () => {
    render(<FeatureFlagsScreen />);
    await userEvent.click(screen.getByRole("button", { name: /enable/i }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: { id: "f1" } },
        body: { enabled: true },
      }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 3: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/admin test -- FeatureFlagsScreen`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the screen**

Create `apps/admin/src/screens/FeatureFlagsScreen.tsx`, mirroring `AdministratorsScreen.tsx`:

- `import type { components } from '@tarmoto/openapi-client'; type FeatureFlag = components['schemas']['FeatureFlagDto'];`
- `@tarmoto/ui`: `Alert, Button, DataTable, type DataTableColumn, Input, PageHeader, Pill`.
- `PageHeader title="Feature Flags"`.
- A "New flag" form: `key` `Input` + `description` `Input` + a create `Button` → `useCreateFlag().mutate({ body: { key, description } }, { onSuccess: () => { reset fields; refetch(); }, onError })`.
- `DataTable` columns: `key` (text), `enabled` (`Pill` accent/ghost), `description`, and an actions column with:
  - a toggle `Button` (label `enabled ? 'Disable' : 'Enable'`, variant `enabled ? 'danger' : 'secondary'`) → `useUpdateFlag().mutate({ params: { path: { id } }, body: { enabled: !enabled } }, { onSuccess: () => void refetch(), onSettled: clear pendingId, onError })`.
  - a `Delete` `Button` (with a `window.confirm` guard) → `useDeleteFlag().mutate({ params: { path: { id } } }, { onSuccess: () => void refetch(), onError })`.
- Per-row loading via `pendingId` (set on click, cleared in `onSettled`).
- Error surfacing: read `statusCode`/`message` from the thrown error body (Phase-2 pattern), set an `actionError` state, render an `Alert intent="danger"`. Surface the list-load `error` too.
- Keep `key` plain text (the test asserts it) and the toggle button labelled "Enable" for a disabled row (the test clicks `/enable/i`).

- [ ] **Step 5: Wire the route**

In `apps/admin/src/app/routes.ts`: change the `feature-flags` entry to `{ key: 'feature-flags', label: 'Feature Flags', minRole: 'admin' }`.
In `apps/admin/src/app/App.tsx`: add a branch `active === 'feature-flags' ? <FeatureFlagsScreen /> : ...` before the "Coming soon" fallback (the `canViewActive` guard already blocks lower roles).

- [ ] **Step 6: Run test + suite + build + lint**

Run: `pnpm --filter @tarmoto/admin test -- FeatureFlagsScreen` → PASS.
Run: `pnpm --filter @tarmoto/admin test && pnpm --filter @tarmoto/admin build && pnpm --filter @tarmoto/admin lint` → all green.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminFlags.ts apps/admin/src/screens/FeatureFlagsScreen.tsx apps/admin/src/screens/FeatureFlagsScreen.test.tsx apps/admin/src/app/routes.ts apps/admin/src/app/App.tsx
git commit -m "feat(cross): add admin Feature Flags screen (list/create/toggle/delete)"
```

---

## Self-Review

**Spec coverage** (against `2026-06-28-admin-phase3-feature-flags-design.md`):

- `feature_flags` store + migration → Task 1. ✓
- Admin CRUD (list/create/update/delete), key validation (400), dup (409), immutable key, 404 → Tasks 2–3. ✓
- `@AdminRoles('admin')` + `setAdminAuditTarget('feature_flag')` on mutations → Task 3. ✓
- Public `GET /config/flags` (flat map, public, cache header) → Task 4. ✓
- Overview `featureFlags` count wired → Task 3 Step 5. ✓
- Shared `FeatureFlagMap` + `isFeatureEnabled` → Task 1. ✓
- SPA screen (list/create/toggle/delete, role-gated `admin`+) + route → Task 5. ✓
- OpenAPI regenerated → Tasks 3, 4. ✓
- Migration registered in both lists; entity in both entity lists → Task 1 Step 3. ✓

**Placeholder scan:** No TBD/TODO. The SPA screen step (Task 5 Step 4) is prose + the exact hooks/components/contracts with the test pinning the toggle behavior — acceptable, mirroring the Phase-2 plan's screen steps. The migration timestamp is concrete (`1782000000000`) with an instruction to bump if a later one exists.

**Type consistency:** `FeatureFlagDto` (id/key/enabled/description/created*at/updated_at) is produced by the service (Task 2), exposed by the controller (Task 3), and consumed by the SPA via `components['schemas']['FeatureFlagDto']` (Task 5). `FeatureFlagMap = Record<string,boolean>` defined in Task 1, consumed by Task 4. `CreateFeatureFlagDto`/`UpdateFeatureFlagDto` names consistent across service↔controller. `setAdminAuditTarget(req, { target_type, target_id })` matches the helper signature; `target_type: 'feature_flag'`. The update body `{ enabled }` in the SPA matches `UpdateFeatureFlagDto`. The `key` validation regex (`^[a-z]a-z0-9*]\*$`) matches the spec.
