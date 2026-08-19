# Admin Phase 2 — User & Admin Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two admin console surfaces — **Users** (app customers: browse + soft-delete/restore) and **Administrators** (staff: list, create, change role, enable/disable) — to the existing admin module and SPA.

**Architecture:** New NestJS controllers/services under `apps/backend/src/modules/admin-users/` and `admin-admins/`, registered in the existing `AdminModule` (so the global `InternalGuard` + `AdminAuditInterceptor` already apply). The Admins API reuses the `create-admin` core (`runCreateAdmin`) and a shared session-revocation helper. Two new Vite/React screens consume the regenerated typed OpenAPI client via `$api`.

**Tech Stack:** NestJS 11, TypeORM + PostGIS, `@nestjs/jwt`, Jest (backend); Vite, React 19, TanStack Query, `openapi-fetch`/`openapi-react-query`, `@tarmoto/ui`, Vitest (admin SPA).

## Global Constraints

- **TypeScript strict.** Backend ESM imports use explicit `.js` extensions. Admin SPA local imports also use `.js`.
- **All new routes live under `/admin/*`** and are already covered by the global `InternalGuard` (auth + role rank) and `AdminAuditInterceptor` (mutation auditing). The backend mounts a global prefix `api/v1`, so the SPA calls **prefixed** paths `/api/v1/admin/...`.
- **Role rank:** `read_only(0) < support(1) < admin(2) < super_admin(3)`. `@AdminRoles('support')` means support-and-above (the guard checks `actualRank >= requiredRank`). Per-target admin checks use `canManageAdminRole(actorRole, targetRole)` = `actorRank > targetRank`.
- **Gating:** Users surface → `@AdminRoles('support')`. Administrators surface → `@AdminRoles('admin')` + `canManageAdminRole` in the service.
- **Safety rails (server-side):** an admin cannot disable/demote their own account; the last active `super_admin` cannot be disabled/demoted. Disabling or demoting an admin revokes its active sessions + refresh tokens.
- **No new schema.** App-user soft-delete toggles `users.deleted_at` (+ `deletion_reason`) directly; the existing `AuthGuard` already blocks users with `deleted_at != null`. No `deletion_scheduled_at` is set (admin soft-delete does NOT enqueue a hard purge).
- **No silent fallbacks.** 404 not-found, 403 forbidden, 409 safety-rail conflicts — each with a clear message.
- **Run a single backend test:** `pnpm --filter @tarmoto/backend test -- --testPathPatterns=<pattern>` (Jest 30, plural flag), or from `apps/backend/`: `npx jest <pattern>`.
- **Run a single admin SPA test:** `pnpm --filter @tarmoto/admin test -- <pattern>`.
- **Regenerate the OpenAPI client after backend endpoint/DTO changes:** `pnpm openapi:gen` (updates `packages/openapi-client/src/generated/schema.d.ts`; `openapi.yaml` is gitignored).
- **Conventional commits**, scope `backend` for backend, `cross` for SPA + cross-cutting (NOT `admin` — commitlint rejects it).

---

## File Structure

**Backend**

- `apps/backend/src/modules/admin-users/dto/admin-users.dto.ts` — query + response DTOs.
- `apps/backend/src/modules/admin-users/admin-users.service.ts` — list/detail/softDelete/restore.
- `apps/backend/src/modules/admin-users/admin-users.controller.ts` — `@Controller('admin')` routes.
- `apps/backend/src/modules/admin-admins/dto/admin-admins.dto.ts` — DTOs.
- `apps/backend/src/modules/admin-admins/admin-admins.service.ts` — list/create/patch (rank gating + safety rails + revoke).
- `apps/backend/src/modules/admin-admins/admin-admins.controller.ts` — routes.
- `apps/backend/src/modules/admin-auth/admin-session-revoke.ts` — extracted `revokeAdminSessions(manager, adminUserId)` helper (shared by `create-admin-core` and the admins service).
- Modify: `apps/backend/src/modules/admin/admin.module.ts` (register controllers/services + `TypeOrmModule.forFeature` entities), `apps/backend/src/scripts/create-admin-core.ts` (use the extracted revoke helper).

**Admin SPA**

- `apps/admin/src/data/useAdminUsers.ts`, `useAdminAdmins.ts` — `$api` hooks.
- `apps/admin/src/screens/UsersScreen.tsx`, `AdministratorsScreen.tsx`.
- Modify: `apps/admin/src/app/routes.ts` (add `administrators`), `apps/admin/src/app/App.tsx` (render the two screens).

---

## Task 1: Backend — AdminUsersService + DTOs (list / detail / soft-delete / restore)

**Files:**

- Create: `apps/backend/src/modules/admin-users/dto/admin-users.dto.ts`
- Create: `apps/backend/src/modules/admin-users/admin-users.service.ts`
- Test: `apps/backend/src/modules/admin-users/admin-users.service.spec.ts`

**Interfaces:**

- Consumes: `User` entity (`apps/backend/src/entities/user.entity.js`); activity entities `Ride` (`user_id`), `HazardReport` (`user_id`), `RoadReview` (`user_id`), `Trip` (`owner_id`), `CommuteRoute` (`user_id`).
- Produces: `AdminUsersService` with `list(query): Promise<AdminUserListResponseDto>`, `getById(id): Promise<AdminUserDetailDto>`, `softDelete(id): Promise<void>`, `restore(id): Promise<void>`. DTOs: `ListAdminUsersQueryDto`, `AdminUserRowDto`, `AdminUserListResponseDto`, `AdminUserDetailDto`.

- [ ] **Step 1: Write the DTOs**

Create `apps/backend/src/modules/admin-users/dto/admin-users.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export const ADMIN_USER_DELETED_FILTERS = ["active", "deleted", "all"] as const;
export type AdminUserDeletedFilter =
  (typeof ADMIN_USER_DELETED_FILTERS)[number];

export class ListAdminUsersQueryDto {
  @ApiPropertyOptional({
    description: "Substring match on email or display_name.",
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: ADMIN_USER_DELETED_FILTERS,
    default: "active",
    description: "Filter by soft-deleted state.",
  })
  @IsOptional()
  @IsIn(ADMIN_USER_DELETED_FILTERS)
  deleted?: AdminUserDeletedFilter;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdminUserRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() display_name!: string;
  @ApiProperty() subscription_tier!: string;
  @ApiProperty() subscription_status!: string;
  @ApiProperty() created_at!: string;
  @ApiProperty({ nullable: true }) deleted_at!: string | null;
}

export class AdminUserListResponseDto {
  @ApiProperty({ type: [AdminUserRowDto] }) rows!: AdminUserRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class AdminUserActivityDto {
  @ApiProperty() rides!: number;
  @ApiProperty() hazardReports!: number;
  @ApiProperty() roadReviews!: number;
  @ApiProperty() trips!: number;
  @ApiProperty() commuteRoutes!: number;
}

export class AdminUserDetailDto extends AdminUserRowDto {
  @ApiProperty({ nullable: true }) home_region!: string | null;
  @ApiProperty({ nullable: true }) email_verified_at!: string | null;
  @ApiProperty({ nullable: true }) subscription_current_period_end!:
    string | null;
  @ApiProperty() subscription_cancel_at_period_end!: boolean;
  @ApiProperty({ nullable: true }) deletion_scheduled_at!: string | null;
  @ApiProperty({ nullable: true }) deletion_reason!: string | null;
  @ApiProperty({ type: AdminUserActivityDto }) activity!: AdminUserActivityDto;
}
```

- [ ] **Step 2: Write the failing service test**

Create `apps/backend/src/modules/admin-users/admin-users.service.spec.ts`:

```typescript
import { NotFoundException } from "@nestjs/common";
import { AdminUsersService } from "./admin-users.service.js";

function repo<T extends object>(over: Partial<T> = {}): T {
  return {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    ...over,
  } as unknown as T;
}

const SAMPLE_USER = {
  id: "u1",
  email: "rider@x.io",
  display_name: "Rider",
  subscription_tier: "free",
  subscription_status: "canceled",
  subscription_current_period_end: null,
  subscription_cancel_at_period_end: false,
  home_region: "CZ",
  email_verified_at: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  deleted_at: null,
  deletion_scheduled_at: null,
  deletion_reason: null,
};

function make(over: { users?: object } = {}) {
  const users =
    over.users ??
    repo({
      findAndCount: jest.fn().mockResolvedValue([[SAMPLE_USER], 1]),
      findOne: jest.fn().mockResolvedValue(SAMPLE_USER),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
  const activity = () => repo({ count: jest.fn().mockResolvedValue(3) });
  const service = new AdminUsersService(
    users as never,
    activity() as never, // rides
    activity() as never, // hazards
    activity() as never, // reviews
    activity() as never, // trips
    activity() as never, // commutes
  );
  return { service, users };
}

describe("AdminUsersService", () => {
  it("list() returns paginated rows + total", async () => {
    const { service, users } = make();
    const res = await service.list({ page: 1, pageSize: 25 });
    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(res.rows[0]).toMatchObject({ id: "u1", email: "rider@x.io" });
    expect(users.findAndCount).toHaveBeenCalled();
  });

  it("getById() includes activity counts", async () => {
    const { service } = make();
    const detail = await service.getById("u1");
    expect(detail.activity).toEqual({
      rides: 3,
      hazardReports: 3,
      roadReviews: 3,
      trips: 3,
      commuteRoutes: 3,
    });
  });

  it("getById() throws NotFound for unknown id", async () => {
    const { service } = make({
      users: repo({ findOne: jest.fn().mockResolvedValue(null) }),
    });
    await expect(service.getById("nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("softDelete() sets deleted_at + reason", async () => {
    const { service, users } = make();
    await service.softDelete("u1");
    expect(users.update).toHaveBeenCalledWith(
      { id: "u1" },
      expect.objectContaining({
        deleted_at: expect.any(Date),
        deletion_reason: expect.any(String),
      }),
    );
  });

  it("restore() clears deleted_at + reason", async () => {
    const { service, users } = make();
    await service.restore("u1");
    expect(users.update).toHaveBeenCalledWith(
      { id: "u1" },
      { deleted_at: null, deletion_scheduled_at: null, deletion_reason: null },
    );
  });
});
```

- [ ] **Step 3: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-users.service`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the service**

Create `apps/backend/src/modules/admin-users/admin-users.service.ts`:

```typescript
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ILike, IsNull, Not, Repository } from "typeorm";
import { User } from "../../entities/user.entity.js";
import { Ride } from "../../entities/ride.entity.js";
import { HazardReport } from "../../entities/hazard-report.entity.js";
import { RoadReview } from "../../entities/road-review.entity.js";
import { Trip } from "../../entities/trip.entity.js";
import { CommuteRoute } from "../../entities/commute-route.entity.js";
import {
  AdminUserDetailDto,
  AdminUserListResponseDto,
  AdminUserRowDto,
  ListAdminUsersQueryDto,
} from "./dto/admin-users.dto.js";

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ride) private readonly rides: Repository<Ride>,
    @InjectRepository(HazardReport)
    private readonly hazards: Repository<HazardReport>,
    @InjectRepository(RoadReview)
    private readonly reviews: Repository<RoadReview>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(CommuteRoute)
    private readonly commutes: Repository<CommuteRoute>,
  ) {}

  async list(query: ListAdminUsersQueryDto): Promise<AdminUserListResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const deleted = query.deleted ?? "active";

    const where: Record<string, unknown> = {};
    if (deleted === "active") where.deleted_at = IsNull();
    else if (deleted === "deleted") where.deleted_at = Not(IsNull());

    const whereClauses = query.q
      ? [
          { ...where, email: ILike(`%${query.q}%`) },
          { ...where, display_name: ILike(`%${query.q}%`) },
        ]
      : where;

    const [rows, total] = await this.users.findAndCount({
      where: whereClauses,
      order: { created_at: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { rows: rows.map((u) => this.toRow(u)), total, page, pageSize };
  }

  async getById(id: string): Promise<AdminUserDetailDto> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException("User not found");

    const [rides, hazardReports, roadReviews, trips, commuteRoutes] =
      await Promise.all([
        this.rides.count({ where: { user_id: id } }),
        this.hazards.count({ where: { user_id: id } }),
        this.reviews.count({ where: { user_id: id } }),
        this.trips.count({ where: { owner_id: id } }),
        this.commutes.count({ where: { user_id: id } }),
      ]);

    return {
      ...this.toRow(u),
      home_region: u.home_region,
      email_verified_at: u.email_verified_at?.toISOString() ?? null,
      subscription_current_period_end:
        u.subscription_current_period_end?.toISOString() ?? null,
      subscription_cancel_at_period_end: u.subscription_cancel_at_period_end,
      deletion_scheduled_at: u.deletion_scheduled_at?.toISOString() ?? null,
      deletion_reason: u.deletion_reason,
      activity: { rides, hazardReports, roadReviews, trips, commuteRoutes },
    };
  }

  async softDelete(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException("User not found");
    await this.users.update(
      { id },
      { deleted_at: new Date(), deletion_reason: "Soft-deleted by admin" },
    );
  }

  async restore(id: string): Promise<void> {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException("User not found");
    await this.users.update(
      { id },
      { deleted_at: null, deletion_scheduled_at: null, deletion_reason: null },
    );
  }

  private toRow(u: User): AdminUserRowDto {
    return {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      subscription_tier: u.subscription_tier,
      subscription_status: u.subscription_status,
      created_at: u.created_at.toISOString(),
      deleted_at: u.deleted_at?.toISOString() ?? null,
    };
  }
}
```

> Note: `softDelete` toggles `deleted_at` directly (admin action) — it does NOT set `deletion_scheduled_at`, so the account-deletion sweeper will not hard-purge the row. The existing `AuthGuard` already blocks users with `deleted_at != null`.

- [ ] **Step 5: Run the test (expect pass)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-users.service`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/admin-users
git commit -m "feat(backend): add admin users service (list/detail/soft-delete/restore)"
```

---

## Task 2: Backend — AdminUsersController + module wiring + OpenAPI

**Files:**

- Create: `apps/backend/src/modules/admin-users/admin-users.controller.ts`
- Test: `apps/backend/src/modules/admin-users/admin-users.controller.spec.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`
- Modify (generated): `packages/openapi-client/src/generated/schema.d.ts`

**Interfaces:**

- Consumes: `AdminUsersService` (Task 1).
- Produces: routes `GET /admin/users`, `GET /admin/users/:id`, `DELETE /admin/users/:id`, `POST /admin/users/:id/restore`, all `@AdminRoles('support')`.

- [ ] **Step 1: Write the failing controller test**

Create `apps/backend/src/modules/admin-users/admin-users.controller.spec.ts`:

```typescript
import { AdminUsersController } from "./admin-users.controller.js";
import { AdminUsersService } from "./admin-users.service.js";

describe("AdminUsersController", () => {
  const service = {
    list: jest
      .fn()
      .mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 }),
    getById: jest.fn().mockResolvedValue({ id: "u1" }),
    softDelete: jest.fn().mockResolvedValue(undefined),
    restore: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AdminUsersService>;
  const controller = new AdminUsersController(service);

  it("GET /admin/users forwards the query", async () => {
    await controller.list({ q: "x" });
    expect(service.list).toHaveBeenCalledWith({ q: "x" });
  });

  it("GET /admin/users/:id forwards the id", async () => {
    await controller.getById("u1");
    expect(service.getById).toHaveBeenCalledWith("u1");
  });

  it("DELETE /admin/users/:id soft-deletes", async () => {
    await controller.softDelete("u1");
    expect(service.softDelete).toHaveBeenCalledWith("u1");
  });

  it("POST /admin/users/:id/restore restores", async () => {
    await controller.restore("u1");
    expect(service.restore).toHaveBeenCalledWith("u1");
  });
});
```

- [ ] **Step 2: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-users.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the controller**

Create `apps/backend/src/modules/admin-users/admin-users.controller.ts`:

```typescript
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminRoles } from "../admin-auth/admin-role.decorator.js";
import { AdminUsersService } from "./admin-users.service.js";
import {
  AdminUserDetailDto,
  AdminUserListResponseDto,
  ListAdminUsersQueryDto,
} from "./dto/admin-users.dto.js";

@ApiTags("admin")
@Controller("admin")
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get("users")
  @AdminRoles("support")
  @ApiOperation({ summary: "List app users (paginated, searchable)" })
  @ApiResponse({ status: 200, type: AdminUserListResponseDto })
  list(
    @Query() query: ListAdminUsersQueryDto,
  ): Promise<AdminUserListResponseDto> {
    return this.service.list(query);
  }

  @Get("users/:id")
  @AdminRoles("support")
  @ApiOperation({ summary: "App user detail + activity counts" })
  @ApiResponse({ status: 200, type: AdminUserDetailDto })
  getById(@Param("id", ParseUUIDPipe) id: string): Promise<AdminUserDetailDto> {
    return this.service.getById(id);
  }

  @Delete("users/:id")
  @AdminRoles("support")
  @HttpCode(204)
  @ApiOperation({ summary: "Soft-delete an app user" })
  softDelete(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.softDelete(id);
  }

  @Post("users/:id/restore")
  @AdminRoles("support")
  @HttpCode(204)
  @ApiOperation({ summary: "Restore a soft-deleted app user" })
  restore(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.service.restore(id);
  }
}
```

- [ ] **Step 4: Register in AdminModule**

In `apps/backend/src/modules/admin/admin.module.ts`: add the activity entities to `TypeOrmModule.forFeature([...])` (`HazardReport`, `RoadReview`, `Trip`, `CommuteRoute` — `User` and `Ride` are already there), add `AdminUsersController` to `controllers`, and `AdminUsersService` to `providers`. Import all with `.js`.

- [ ] **Step 5: Run controller test + full suite**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-users.controller`
Expected: PASS (4 tests).
Run: `pnpm --filter @tarmoto/backend test`
Expected: full suite green.

- [ ] **Step 6: Regenerate the OpenAPI client**

Run: `pnpm openapi:gen`
Expected: `packages/openapi-client/src/generated/schema.d.ts` now contains `/api/v1/admin/users` and `/api/v1/admin/users/{id}` paths.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-users apps/backend/src/modules/admin/admin.module.ts packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): expose admin users endpoints (support+)"
```

---

## Task 3: Backend — shared session-revoke helper + AdminAdminsService

**Files:**

- Create: `apps/backend/src/modules/admin-auth/admin-session-revoke.ts`
- Modify: `apps/backend/src/scripts/create-admin-core.ts` (use the helper)
- Create: `apps/backend/src/modules/admin-admins/dto/admin-admins.dto.ts`
- Create: `apps/backend/src/modules/admin-admins/admin-admins.service.ts`
- Test: `apps/backend/src/modules/admin-admins/admin-admins.service.spec.ts`

**Interfaces:**

- Consumes: `runCreateAdmin(manager, options, password)` + `CreateAdminResult` from `create-admin-core.js`; `CreateAdminOptions`/`VALID_ROLES` from `create-admin-args.js`; `canManageAdminRole` from `admin-role-rank.js`; `AdminUser`/`AdminRole`, `AdminSession`, `AdminRefreshToken` entities; `DataSource`.
- Produces: `revokeAdminSessions(manager: EntityManager, adminUserId: string): Promise<void>`. `AdminAdminsService` with `list()`, `create(actor, dto)`, `patch(actor, id, dto)`. DTOs `AdminRowDto`, `CreateAdminDto`, `PatchAdminDto`.

- [ ] **Step 1: Extract the revoke helper**

Create `apps/backend/src/modules/admin-auth/admin-session-revoke.ts`:

```typescript
import { EntityManager, In, IsNull } from "typeorm";
import { AdminSession } from "../../entities/admin-session.entity.js";
import { AdminRefreshToken } from "../../entities/admin-refresh-token.entity.js";

/**
 * Revoke ALL of an admin's active sessions and their refresh tokens.
 * Shared by the create-admin CLI core (credential rotation / reactivation)
 * and the admin-admins service (disable / demote).
 */
export async function revokeAdminSessions(
  manager: EntityManager,
  adminUserId: string,
): Promise<void> {
  const now = new Date();
  const sessions = await manager
    .getRepository(AdminSession)
    .find({ where: { admin_user_id: adminUserId }, select: { id: true } });

  await manager
    .getRepository(AdminSession)
    .update(
      { admin_user_id: adminUserId, revoked_at: IsNull() },
      { revoked_at: now },
    );

  if (sessions.length > 0) {
    await manager
      .getRepository(AdminRefreshToken)
      .update(
        { session_id: In(sessions.map((s) => s.id)), revoked_at: IsNull() },
        { revoked_at: now },
      );
  }
}
```

Then in `apps/backend/src/scripts/create-admin-core.ts`, replace the inline session+token revocation block (the `sessionRepo`/`tokenRepo` updates inside the credential-change/reactivation branch) with a call to `revokeAdminSessions(manager, existing.id)` and set `sessionsRevoked = true`. Import it with `.js`. Re-run the create-admin tests to confirm no behavior change:

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=create-admin`
Expected: PASS (existing create-admin tests still green; the revoke assertions still pass since `revokeAdminSessions` issues the same `sessionRepo.update({ admin_user_id }, …)` + token update).

- [ ] **Step 2: Write the Admins DTOs**

Create `apps/backend/src/modules/admin-admins/dto/admin-admins.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";
import { VALID_ROLES } from "../../scripts/create-admin-args.js";
import type { AdminRole } from "../../entities/admin-user.entity.js";

export class AdminRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: VALID_ROLES }) role!: AdminRole;
  @ApiProperty({ enum: ["active", "disabled"] }) status!: "active" | "disabled";
  @ApiProperty({ nullable: true }) last_login_at!: string | null;
  @ApiProperty() created_at!: string;
}

export class CreateAdminDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: VALID_ROLES }) @IsIn(VALID_ROLES) role!: AdminRole;
  @ApiProperty({ enum: ["password", "sso-only"] })
  @IsIn(["password", "sso-only"])
  mode!: "password" | "sso-only";
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class PatchAdminDto {
  @ApiPropertyOptional({ enum: VALID_ROLES })
  @IsOptional()
  @IsIn(VALID_ROLES)
  role?: AdminRole;

  @ApiPropertyOptional({ description: "true = active, false = disabled" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
```

- [ ] **Step 3: Write the failing service test**

Create `apps/backend/src/modules/admin-admins/admin-admins.service.spec.ts`:

```typescript
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { AdminAdminsService } from "./admin-admins.service.js";

type Actor = {
  id: string;
  role: "read_only" | "support" | "admin" | "super_admin";
};

function makeService(opts: {
  target?: object | null;
  superAdminCount?: number;
}) {
  const adminRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(opts.target ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(opts.superAdminCount ?? 2),
  };
  const manager = { getRepository: jest.fn().mockReturnValue(adminRepo) };
  const dataSource = {
    getRepository: jest.fn().mockReturnValue(adminRepo),
    transaction: jest
      .fn()
      .mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    manager,
  };
  const service = new AdminAdminsService(dataSource as never);
  return { service, adminRepo, dataSource };
}

const SUPER: Actor = { id: "super1", role: "super_admin" };
const ADMIN: Actor = { id: "admin1", role: "admin" };

describe("AdminAdminsService", () => {
  it("create: admin cannot create an admin-or-higher (rank gate)", async () => {
    const { service } = makeService({});
    await expect(
      service.create(ADMIN, {
        email: "x@x.io",
        role: "admin",
        mode: "sso-only",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("create: password mode requires a password", async () => {
    const { service } = makeService({});
    await expect(
      service.create(SUPER, {
        email: "x@x.io",
        role: "support",
        mode: "password",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("patch: cannot modify your own account", async () => {
    const { service } = makeService({
      target: { id: "super1", role: "super_admin", status: "active" },
    });
    await expect(
      service.patch(SUPER, "super1", { active: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("patch: cannot disable the last active super_admin", async () => {
    const { service } = makeService({
      target: { id: "super2", role: "super_admin", status: "active" },
      superAdminCount: 1,
    });
    await expect(
      service.patch(SUPER, "super2", { active: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("patch: admin cannot manage another admin (rank gate)", async () => {
    const { service } = makeService({
      target: { id: "admin2", role: "admin", status: "active" },
    });
    await expect(
      service.patch(ADMIN, "admin2", { role: "support" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("patch: disabling an admin revokes their sessions", async () => {
    const { service, adminRepo } = makeService({
      target: { id: "sup2", role: "support", status: "active" },
      superAdminCount: 2,
    });
    await service.patch(SUPER, "sup2", { active: false });
    // status updated to disabled
    expect(adminRepo.update).toHaveBeenCalledWith(
      { id: "sup2" },
      expect.objectContaining({ status: "disabled" }),
    );
    // sessions revoked (revokeAdminSessions issues a session update by admin_user_id)
    expect(adminRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ admin_user_id: "sup2" }),
      expect.objectContaining({ revoked_at: expect.any(Date) }),
    );
  });
});
```

- [ ] **Step 4: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-admins.service`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement the service**

Create `apps/backend/src/modules/admin-admins/admin-admins.service.ts`:

```typescript
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AdminUser, type AdminRole } from "../../entities/admin-user.entity.js";
import { canManageAdminRole } from "../admin-auth/admin-role-rank.js";
import { revokeAdminSessions } from "../admin-auth/admin-session-revoke.js";
import { runCreateAdmin } from "../../scripts/create-admin-core.js";
import {
  AdminRowDto,
  CreateAdminDto,
  PatchAdminDto,
} from "./dto/admin-admins.dto.js";

export interface ActingAdmin {
  id: string;
  role: AdminRole;
}

@Injectable()
export class AdminAdminsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(): Promise<AdminRowDto[]> {
    const rows = await this.dataSource.getRepository(AdminUser).find({
      order: { created_at: "DESC" },
    });
    return rows.map((a) => this.toRow(a));
  }

  async create(actor: ActingAdmin, dto: CreateAdminDto): Promise<AdminRowDto> {
    if (!canManageAdminRole(actor.role, dto.role)) {
      throw new ForbiddenException(
        "Cannot create an admin at or above your role",
      );
    }
    if (
      dto.mode === "password" &&
      (!dto.password || dto.password.length === 0)
    ) {
      throw new BadRequestException("Password is required for password mode");
    }
    const password = dto.mode === "sso-only" ? null : (dto.password ?? null);

    const created = await this.dataSource.transaction((manager) =>
      runCreateAdmin(
        manager,
        {
          email: dto.email,
          role: dto.role,
          ssoOnly: dto.mode === "sso-only",
          help: false,
        },
        password,
      ),
    );
    const row = await this.dataSource
      .getRepository(AdminUser)
      .findOne({ where: { email: created.email } });
    if (!row) throw new NotFoundException("Admin not found after create");
    return this.toRow(row);
  }

  async patch(
    actor: ActingAdmin,
    id: string,
    dto: PatchAdminDto,
  ): Promise<AdminRowDto> {
    const repo = this.dataSource.getRepository(AdminUser);
    const target = await repo.findOne({ where: { id } });
    if (!target) throw new NotFoundException("Admin not found");

    const newRole = dto.role ?? target.role;
    const newStatus: "active" | "disabled" =
      dto.active === undefined
        ? target.status
        : dto.active
          ? "active"
          : "disabled";

    const demoting =
      dto.role !== undefined && ROLE_RANK[newRole] < ROLE_RANK[target.role];
    const disabling = newStatus === "disabled" && target.status === "active";

    // Safety rail 1: no self-disable / self-demote.
    if (actor.id === target.id && (disabling || demoting)) {
      throw new ForbiddenException(
        "You cannot disable or demote your own account",
      );
    }
    // Rank gate: must out-rank the current target, and (for role changes) the new role.
    if (!canManageAdminRole(actor.role, target.role)) {
      throw new ForbiddenException(
        "You cannot manage an admin at or above your role",
      );
    }
    if (dto.role !== undefined && !canManageAdminRole(actor.role, newRole)) {
      throw new ForbiddenException(
        "You cannot assign a role at or above your own",
      );
    }
    // Safety rail 2: protect the last active super_admin.
    if (
      target.role === "super_admin" &&
      (disabling || (demoting && newRole !== "super_admin"))
    ) {
      const activeSupers = await repo.count({
        where: { role: "super_admin", status: "active" },
      });
      if (activeSupers <= 1) {
        throw new ConflictException(
          "Cannot disable or demote the last super_admin",
        );
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(AdminUser)
        .update({ id }, { role: newRole, status: newStatus });
      if (disabling || demoting) {
        await revokeAdminSessions(manager, id);
      }
    });

    const updated = await repo.findOne({ where: { id } });
    return this.toRow(updated!);
  }

  private toRow(a: AdminUser): AdminRowDto {
    return {
      id: a.id,
      email: a.email,
      role: a.role,
      status: a.status,
      last_login_at: a.last_login_at?.toISOString() ?? null,
      created_at: a.created_at.toISOString(),
    };
  }
}

const ROLE_RANK: Record<AdminRole, number> = {
  read_only: 0,
  support: 1,
  admin: 2,
  super_admin: 3,
};
```

> The test mocks `dataSource.getRepository` and `transaction(cb)` to return one shared `adminRepo` mock for every entity, so `revokeAdminSessions` (which calls `getRepository(AdminSession)`) hits the same mock — that's why the disable test asserts an update with `{ admin_user_id }`.

- [ ] **Step 6: Run the test (expect pass)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-admins.service`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-auth/admin-session-revoke.ts apps/backend/src/scripts/create-admin-core.ts apps/backend/src/modules/admin-admins
git commit -m "feat(backend): add admin-admins service with rank gating, safety rails, session revoke"
```

---

## Task 4: Backend — AdminAdminsController + module wiring + OpenAPI

**Files:**

- Create: `apps/backend/src/modules/admin-admins/admin-admins.controller.ts`
- Test: `apps/backend/src/modules/admin-admins/admin-admins.controller.spec.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts`, `packages/openapi-client/src/generated/schema.d.ts`

**Interfaces:**

- Consumes: `AdminAdminsService` (Task 3); `AdminRequest` (`../admin/internal.guard.js`).
- Produces: `GET /admin/admins`, `POST /admin/admins`, `PATCH /admin/admins/:id`, all `@AdminRoles('admin')`; passes `req.adminUser` as the acting admin.

- [ ] **Step 1: Write the failing controller test**

Create `apps/backend/src/modules/admin-admins/admin-admins.controller.spec.ts`:

```typescript
import type { AdminRequest } from "../admin/internal.guard.js";
import { AdminAdminsController } from "./admin-admins.controller.js";
import { AdminAdminsService } from "./admin-admins.service.js";

describe("AdminAdminsController", () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "a1" }),
    patch: jest.fn().mockResolvedValue({ id: "a1" }),
  } as unknown as jest.Mocked<AdminAdminsService>;
  const controller = new AdminAdminsController(service);
  const req = {
    adminUser: { id: "super1", role: "super_admin" },
  } as unknown as AdminRequest;

  it("GET /admin/admins lists", async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalled();
  });

  it("POST /admin/admins passes the acting admin + dto", async () => {
    const dto = {
      email: "x@x.io",
      role: "support" as const,
      mode: "sso-only" as const,
    };
    await controller.create(req, dto);
    expect(service.create).toHaveBeenCalledWith(
      { id: "super1", role: "super_admin" },
      dto,
    );
  });

  it("PATCH /admin/admins/:id passes actor, id, dto", async () => {
    await controller.patch(req, "a1", { active: false });
    expect(service.patch).toHaveBeenCalledWith(
      { id: "super1", role: "super_admin" },
      "a1",
      { active: false },
    );
  });
});
```

- [ ] **Step 2: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-admins.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the controller**

Create `apps/backend/src/modules/admin-admins/admin-admins.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminRoles } from "../admin-auth/admin-role.decorator.js";
import type { AdminRequest } from "../admin/internal.guard.js";
import {
  AdminAdminsService,
  type ActingAdmin,
} from "./admin-admins.service.js";
import {
  AdminRowDto,
  CreateAdminDto,
  PatchAdminDto,
} from "./dto/admin-admins.dto.js";

@ApiTags("admin")
@Controller("admin")
export class AdminAdminsController {
  constructor(private readonly service: AdminAdminsService) {}

  private actor(req: AdminRequest): ActingAdmin {
    if (!req.adminUser) throw new UnauthorizedException();
    return { id: req.adminUser.id, role: req.adminUser.role };
  }

  @Get("admins")
  @AdminRoles("admin")
  @ApiOperation({ summary: "List admin (staff) accounts" })
  @ApiResponse({ status: 200, type: [AdminRowDto] })
  list(): Promise<AdminRowDto[]> {
    return this.service.list();
  }

  @Post("admins")
  @AdminRoles("admin")
  @ApiOperation({ summary: "Create an admin account" })
  @ApiResponse({ status: 201, type: AdminRowDto })
  create(
    @Req() req: AdminRequest,
    @Body() dto: CreateAdminDto,
  ): Promise<AdminRowDto> {
    return this.service.create(this.actor(req), dto);
  }

  @Patch("admins/:id")
  @AdminRoles("admin")
  @ApiOperation({ summary: "Change an admin role / enable-disable" })
  @ApiResponse({ status: 200, type: AdminRowDto })
  patch(
    @Req() req: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PatchAdminDto,
  ): Promise<AdminRowDto> {
    return this.service.patch(this.actor(req), id, dto);
  }
}
```

- [ ] **Step 4: Register in AdminModule**

In `apps/backend/src/modules/admin/admin.module.ts`: add `AdminAdminsController` to `controllers` and `AdminAdminsService` to `providers`. `AdminRefreshToken` must be in `TypeOrmModule.forFeature([...])` (for `revokeAdminSessions`); `AdminUser`/`AdminSession` are already there. Imports with `.js`.

- [ ] **Step 5: Run controller test + full suite + e2e check**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns=admin-admins.controller`
Expected: PASS (3 tests).
Run: `pnpm --filter @tarmoto/backend test`
Expected: full suite green.

Add an e2e assertion to the existing `apps/backend/test/admin-auth.e2e-spec.ts` (or a new `admin-management.e2e-spec.ts` mirroring its bootstrap, with `setGlobalPrefix('api/v1')`): a `read_only` session calling `GET /api/v1/admin/admins` gets 403, and a `super_admin` session gets 200. (Mirror the Phase 1 e2e's session-seeding helper.) Run:
`pnpm --filter @tarmoto/backend test:e2e -- --testPathPatterns=admin-management` (skip/downgrade to integration with a note if no e2e DB harness, as Phase 1 did).

- [ ] **Step 6: Regenerate OpenAPI**

Run: `pnpm openapi:gen`
Expected: `schema.d.ts` contains `/api/v1/admin/admins` (GET, POST) and `/api/v1/admin/admins/{id}` (PATCH).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/modules/admin-admins apps/backend/src/modules/admin/admin.module.ts apps/backend/test packages/openapi-client/src/generated/schema.d.ts
git commit -m "feat(backend): expose admin-admins endpoints (admin+, rank-gated)"
```

---

## Task 5: SPA — Users screen

**Files:**

- Create: `apps/admin/src/data/useAdminUsers.ts`
- Create: `apps/admin/src/screens/UsersScreen.tsx`
- Test: `apps/admin/src/screens/UsersScreen.test.tsx`
- Modify: `apps/admin/src/app/App.tsx` (render `users` → `UsersScreen`)

**Interfaces:**

- Consumes: `$api` from `../data/apiClient.js`; the regenerated `/api/v1/admin/users` paths.
- Produces: `useAdminUsersList(params)`, `useAdminUserDetail(id)`, `useSoftDeleteUser()`, `useRestoreUser()` hooks; `UsersScreen` component.

- [ ] **Step 1: Implement the hooks**

Create `apps/admin/src/data/useAdminUsers.ts`:

```typescript
import { $api } from "./apiClient.js";

export function useAdminUsersList(params: {
  q?: string;
  deleted?: "active" | "deleted" | "all";
  page?: number;
  pageSize?: number;
}) {
  return $api.useQuery("get", "/api/v1/admin/users", {
    params: { query: params },
  });
}

export function useAdminUserDetail(id: string | null) {
  return $api.useQuery(
    "get",
    "/api/v1/admin/users/{id}",
    { params: { path: { id: id ?? "" } } },
    { enabled: !!id },
  );
}

export function useSoftDeleteUser() {
  return $api.useMutation("delete", "/api/v1/admin/users/{id}");
}

export function useRestoreUser() {
  return $api.useMutation("post", "/api/v1/admin/users/{id}/restore");
}
```

> If the installed `openapi-react-query` query/mutation signature differs (param shape), adapt to it — the goal is a typed query against the listed paths returning `{ data, isPending, error }` and mutations callable as `mutation.mutate({ params: { path: { id } } })`.

- [ ] **Step 2: Write the failing screen test**

Create `apps/admin/src/screens/UsersScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsersScreen } from "./UsersScreen.js";

vi.mock("../data/useAdminUsers.js", () => ({
  useAdminUsersList: () => ({
    data: {
      rows: [
        {
          id: "u1",
          email: "rider@x.io",
          display_name: "Rider",
          subscription_tier: "free",
          subscription_status: "canceled",
          created_at: "2026-01-01T00:00:00Z",
          deleted_at: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    },
    isPending: false,
    error: null,
  }),
  useAdminUserDetail: () => ({ data: null, isPending: false, error: null }),
  useSoftDeleteUser: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreUser: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("UsersScreen", () => {
  it("renders the user rows", () => {
    render(<UsersScreen />);
    expect(screen.getByText("rider@x.io")).toBeInTheDocument();
    expect(screen.getByText("Rider")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/admin test -- UsersScreen`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the screen**

Create `apps/admin/src/screens/UsersScreen.tsx` — a `PageHeader` "Users", a search `Input` (controlled, drives the `q` param via local state) + a `deleted` filter `Select`, and a table of rows (email, display_name, tier/status `Pill`, created date, a soft-delete/restore `Button` per row using the mutations). Use `@tarmoto/ui` (`PageHeader`, `Input`, `Select`, `Button`, `Pill`, `Card`, `Alert`) and Tailwind utility classes consistent with `OverviewScreen`. Show `—`/loading and an `Alert` on error. Keep the email + display_name as plain text (the test asserts them). Mutations call `mutate({ params: { path: { id } } })` and invalidate/refetch the list on success.

- [ ] **Step 5: Wire the route**

In `apps/admin/src/app/App.tsx`, render `active === 'users'` → `<UsersScreen />` (the `users` route already exists in `routes.ts`). Keep the "Coming soon" stub for the remaining routes.

- [ ] **Step 6: Run test + build**

Run: `pnpm --filter @tarmoto/admin test -- UsersScreen` → PASS.
Run: `pnpm --filter @tarmoto/admin test && pnpm --filter @tarmoto/admin build && pnpm --filter @tarmoto/admin lint` → all green.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminUsers.ts apps/admin/src/screens/UsersScreen.tsx apps/admin/src/screens/UsersScreen.test.tsx apps/admin/src/app/App.tsx
git commit -m "feat(cross): add admin Users screen (search/filter/soft-delete/restore)"
```

---

## Task 6: SPA — Administrators screen

**Files:**

- Create: `apps/admin/src/data/useAdminAdmins.ts`
- Create: `apps/admin/src/screens/AdministratorsScreen.tsx`
- Test: `apps/admin/src/screens/AdministratorsScreen.test.tsx`
- Modify: `apps/admin/src/app/routes.ts` (add `administrators`), `apps/admin/src/app/App.tsx` (render it)

**Interfaces:**

- Consumes: `$api`; the `/api/v1/admin/admins` paths; the current admin's role from `useAdminAuth` (to gate which controls render — `canManage = rank(currentRole) > rank(targetRole)`).
- Produces: `useAdminAdminsList()`, `useCreateAdmin()`, `usePatchAdmin()`; `AdministratorsScreen`.

- [ ] **Step 1: Implement the hooks**

Create `apps/admin/src/data/useAdminAdmins.ts`:

```typescript
import { $api } from "./apiClient.js";

export function useAdminAdminsList() {
  return $api.useQuery("get", "/api/v1/admin/admins");
}
export function useCreateAdmin() {
  return $api.useMutation("post", "/api/v1/admin/admins");
}
export function usePatchAdmin() {
  return $api.useMutation("patch", "/api/v1/admin/admins/{id}");
}
```

- [ ] **Step 2: Write the failing screen test**

Create `apps/admin/src/screens/AdministratorsScreen.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdministratorsScreen } from "./AdministratorsScreen.js";

vi.mock("../data/useAdminAdmins.js", () => ({
  useAdminAdminsList: () => ({
    data: [
      {
        id: "a1",
        email: "ops@tarmoto.app",
        role: "admin",
        status: "active",
        last_login_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    isPending: false,
    error: null,
  }),
  useCreateAdmin: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchAdmin: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("AdministratorsScreen", () => {
  it("renders the admin roster", () => {
    render(
      <AdministratorsScreen
        currentRole="super_admin"
        currentAdminId="super1"
      />,
    );
    expect(screen.getByText("ops@tarmoto.app")).toBeInTheDocument();
    expect(screen.getByText(/admin/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it (expect fail)**

Run: `pnpm --filter @tarmoto/admin test -- AdministratorsScreen`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the screen**

Create `apps/admin/src/screens/AdministratorsScreen.tsx` — props `{ currentRole, currentAdminId }`. A `PageHeader` "Administrators", a roster table (email, role `Pill`, status `Pill`, last login), a "New admin" form (email `Input`, role `Select`, mode `SegmentedControl`/`Select` password|sso-only, password `Input` shown when mode=password) calling `useCreateAdmin`, and per-row controls (role `Select`, enable/disable `Button`) calling `usePatchAdmin`. Gate controls: only render mutate controls for a row when `rank(currentRole) > rank(row.role)` and `row.id !== currentAdminId` (mirror the server rank rule + self-lockout). Surface server errors (403/409) via `Alert`. Use `@tarmoto/ui` components. Define a local `ROLE_RANK` map for the gating.

- [ ] **Step 5: Wire the route + nav**

In `apps/admin/src/app/routes.ts`, add `{ key: 'administrators', label: 'Administrators' }`. In `App.tsx`, render `active === 'administrators'` → `<AdministratorsScreen currentRole={auth.user.role} currentAdminId={auth.user.id} />`.

- [ ] **Step 6: Run test + suite + build + lint**

Run: `pnpm --filter @tarmoto/admin test -- AdministratorsScreen` → PASS.
Run: `pnpm --filter @tarmoto/admin test && pnpm --filter @tarmoto/admin build && pnpm --filter @tarmoto/admin lint` → all green.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/data/useAdminAdmins.ts apps/admin/src/screens/AdministratorsScreen.tsx apps/admin/src/screens/AdministratorsScreen.test.tsx apps/admin/src/app/routes.ts apps/admin/src/app/App.tsx
git commit -m "feat(cross): add admin Administrators screen (create/role/disable, rank-gated)"
```

---

## Self-Review

**Spec coverage** (against `2026-06-27-admin-phase2-user-admin-management-design.md`):

- Users list/search/filter/paginate + detail (activity counts) + soft-delete + restore → Tasks 1–2. ✓
- Administrators list + create (password/sso-only) + role change + enable/disable → Tasks 3–4. ✓
- Reuse `create-admin` core + shared `revokeAdminSessions` → Task 3. ✓
- Role-rank gating (`support`+ users, `admin`+ admins + `canManageAdminRole`) → Tasks 2, 4, 3. ✓
- Safety rails (self-lockout, last super_admin) + session revoke on disable/demote → Task 3 (tested). ✓
- SPA Users + Administrators screens, route wiring, role-gated controls → Tasks 5–6. ✓
- OpenAPI regen after backend changes → Tasks 2, 4. ✓
- No new schema; soft-delete via `deleted_at` → Task 1. ✓
- Audit: handled by the existing global interceptor (mutations) + guard (`insufficient_role`) — no new code; e2e gating check in Task 4. ✓

**Placeholder scan:** No TBD/TODO. The screen UI steps (4) describe the component with the exact `@tarmoto/ui` primitives + the testable assertions rather than full JSX — acceptable since the data/route contracts are fully specified and the test pins the behavior; the implementer mirrors `OverviewScreen`. The e2e step (Task 4 Step 5) is structural with a documented downgrade, matching the Phase 1 e2e harness.

**Type consistency:** `ActingAdmin {id, role}` is produced by the controller (Task 4) and consumed by the service (Task 3). `revokeAdminSessions(manager, adminUserId)` defined Task 3, reused in `create-admin-core` + the admins service. DTO names (`AdminUserRowDto`/`AdminUserDetailDto`/`AdminRowDto`/`CreateAdminDto`/`PatchAdminDto`) consistent across service↔controller↔SPA. `canManageAdminRole(actor, target)` = actorRank > targetRank used identically server-side (Task 3) and for SPA control-gating (Task 6). Activity FK columns (`user_id` for rides/hazards/reviews/commutes, `owner_id` for trips) match the entities.
