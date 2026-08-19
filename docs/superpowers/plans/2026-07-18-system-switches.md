# System Switches (Feature-Flag Catalog Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the system-switch mechanism — a third feature-registry kind for operator-only, default-on, no-tier global kill toggles — plus its admin surface and the 14 `sys_*` switches from the catalog.

**Architecture:** A `kind: "system"` member of the shared `FeatureDefinition` union (default `true`, no tiers), resolved by a dedicated pure `resolveSystemSwitch` (on unless an operator `force_off`). Overrides reuse the existing `feature_states` table and already ride on `GET /config/flags`. A dedicated `/admin/system-switches` surface (disable/enable only) manages them, plus a `SystemSwitchesCard` on the admin Feature Flags screen. No migration, no seed, no enforcement wiring (each switch is wired to its subsystem in a later per-feature PR). Spec: `docs/superpowers/specs/2026-07-18-system-switches-design.md`.

**Tech Stack:** TypeScript strict; shared = vitest; backend = NestJS 11 + TypeORM + jest (`--testPathPatterns`); admin = Vite + vitest + `@tarmoto/ui` + openapi-react-query (`$api`); OpenAPI regen via `pnpm openapi:gen`.

## Global Constraints

- System switches **default ON** (`default: true`, no tiers). The only operator action is `force_off` (disable) or clearing it (enable). `force_on` is meaningless and treated as on.
- **Reuse `feature_states`** for overrides. **No migration, no seed, no schema change** — default-on means zero rows until a switch is disabled.
- `TOGGLE_FEATURE_KEYS` / `LIMIT_FEATURE_KEYS` must stay exactly as-is — system keys never enter the per-user snapshot (`buildFeatureSnapshot`), `FeatureSnapshotDto`/`LimitSnapshotDto`, or the flag/limit admin listings.
- **No enforcement wiring** — no `sys_*` switch gates any subsystem in this phase; no `@RequireFeature`-style guard is added for a system key.
- Wire is additive: no client-facing endpoint/field changes (system switches already ride on the existing `/config/flags`). Only the new `/admin/system-switches` endpoints are added to the contract.
- Repo green (build + typecheck + tests) after every task's commit. Conventional commits, lowercase subjects, scope `shared`/`backend`/`admin`/`openapi`/`cross`. Commit-body trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend ESM imports use `.js` suffixes; shared uses double quotes; backend/admin single quotes. `pnpm openapi:gen` is the strict-tsc oracle. Run `pnpm backend:lint` locally (separate CI step).
- The admin system-switch files live in the existing `apps/backend/src/modules/admin-flags/` folder (that is where the `admin-limits` twin lives), registered in `apps/backend/src/modules/admin/admin.module.ts`. `FeatureState` is **already** in that module's `TypeOrmModule.forFeature` — no new entity registration.

---

### Task 1: Shared registry — `kind: "system"` + 14 keys + resolver helpers

**Files:**

- Modify: `packages/shared/src/feature-flags.ts`
- Modify: `packages/shared/src/feature-flags.spec.ts`

**Interfaces:**

- Consumes: existing `GlobalFeatureState`, `FeatureDefinition` union, `FEATURE_DEFINITIONS`, `FeatureKey`, the `as const satisfies` pattern.
- Produces (later tasks depend on these exact names): `SystemFeatureDefinition`, `SystemFeatureKey`, `SYSTEM_FEATURE_KEYS`, `isSystemFeatureKey(v): v is SystemFeatureKey`, `SystemSwitchSnapshot = Record<SystemFeatureKey, boolean>`, `resolveSystemSwitch(key: SystemFeatureKey, globalState: GlobalFeatureState | undefined): boolean`, `buildSystemSwitchSnapshot(globalStates): SystemSwitchSnapshot`. `FeatureKey` grows to include system keys; `TOGGLE_FEATURE_KEYS`/`LIMIT_FEATURE_KEYS` unchanged.

- [ ] **Step 1: Write the failing tests** — append to `feature-flags.spec.ts` (merge the new imports into the existing single `./feature-flags` import statement):

```ts
import {
  SYSTEM_FEATURE_KEYS,
  buildSystemSwitchSnapshot,
  isSystemFeatureKey,
  resolveSystemSwitch,
} from "./feature-flags";

describe("system switches", () => {
  it("has 14 system keys, all kind:system + default:true, disjoint from toggle/limit", () => {
    expect(SYSTEM_FEATURE_KEYS.length).toBe(14);
    for (const key of SYSTEM_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("system");
      expect(FEATURE_DEFINITIONS[key].default).toBe(true);
    }
    const toggleLimit = new Set([
      ...TOGGLE_FEATURE_KEYS,
      ...LIMIT_FEATURE_KEYS,
    ]);
    for (const key of SYSTEM_FEATURE_KEYS) {
      expect(toggleLimit.has(key as never)).toBe(false);
    }
  });

  it("resolveSystemSwitch is on by default and off only on force_off", () => {
    expect(resolveSystemSwitch("sys_weather_provider", undefined)).toBe(true);
    expect(resolveSystemSwitch("sys_weather_provider", "force_on")).toBe(true);
    expect(resolveSystemSwitch("sys_weather_provider", "force_off")).toBe(
      false,
    );
  });

  it("buildSystemSwitchSnapshot resolves every key; absent = on; ignores stale keys", () => {
    const snap = buildSystemSwitchSnapshot({
      sys_weather_provider: "force_off",
    });
    expect(Object.keys(snap).sort()).toEqual([...SYSTEM_FEATURE_KEYS].sort());
    expect(snap.sys_weather_provider).toBe(false);
    expect(snap.sys_mapillary_previews).toBe(true); // absent → default on
    expect(snap).not.toHaveProperty("ghost_switch");
  });

  it("isSystemFeatureKey discriminates by kind", () => {
    expect(isSystemFeatureKey("sys_weather_provider")).toBe(true);
    expect(isSystemFeatureKey("gpx_export")).toBe(false);
    expect(isSystemFeatureKey("max_active_trips")).toBe(false);
    expect(isSystemFeatureKey("nope")).toBe(false);
  });
});
```

Also update the existing partition test — find `it("partitions FEATURE_KEYS exactly into toggle + limit keys", ...)` and make it 3-way:

```ts
it("partitions FEATURE_KEYS exactly into toggle + limit + system keys", () => {
  expect(
    [
      ...TOGGLE_FEATURE_KEYS,
      ...LIMIT_FEATURE_KEYS,
      ...SYSTEM_FEATURE_KEYS,
    ].sort(),
  ).toEqual([...FEATURE_KEYS].sort());
  for (const key of TOGGLE_FEATURE_KEYS) {
    expect(FEATURE_DEFINITIONS[key].kind).toBe("toggle");
  }
  for (const key of LIMIT_FEATURE_KEYS) {
    expect(FEATURE_DEFINITIONS[key].kind).toBe("limit");
  }
  for (const key of SYSTEM_FEATURE_KEYS) {
    expect(FEATURE_DEFINITIONS[key].kind).toBe("system");
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/shared test`
Expected: FAIL — `SYSTEM_FEATURE_KEYS`/`resolveSystemSwitch` not exported; partition test expects system keys that don't exist yet.

- [ ] **Step 3: Add the union member** in `feature-flags.ts`, right after `LimitFeatureDefinition`:

```ts
export interface SystemFeatureDefinition {
  kind: "system";
  description: string;
  /** System switches default ON; an operator force_off is the only way off. */
  default: true;
}

export type FeatureDefinition =
  ToggleFeatureDefinition | LimitFeatureDefinition | SystemFeatureDefinition;
```

(Delete the old two-member `FeatureDefinition` union.)

- [ ] **Step 4: Add the 14 system entries** to `FEATURE_DEFINITIONS`, after the last limit entry (`hazard_reports_per_day`) and before the closing `} as const satisfies ...`:

```ts
  // ── System switches (operator-only, default ON, no tier) ──
  sys_accel_collection: {
    kind: "system",
    description: "Background accelerometer/gyro sampling (50Hz).",
    default: true,
  },
  sys_surface_upload: {
    kind: "system",
    description: "Batch upload of surface data to the backend.",
    default: true,
  },
  sys_surface_ml_classification: {
    kind: "system",
    description: "On-device TF Lite surface classification.",
    default: true,
  },
  sys_nap_conditions: {
    kind: "system",
    description: "NAP/DATEX II closure display (CONDITIONS tab + map).",
    default: true,
  },
  sys_nap_routing_avoidance: {
    kind: "system",
    description: "Closures injected as Valhalla exclude_polygons.",
    default: true,
  },
  sys_weather_provider: {
    kind: "system",
    description: "Weather-along-route data.",
    default: true,
  },
  sys_mapillary_previews: {
    kind: "system",
    description: "Mapillary imagery in Road Preview Cards.",
    default: true,
  },
  sys_aerial_basemap: {
    kind: "system",
    description: "ČÚZK orthophoto basemap toggle.",
    default: true,
  },
  sys_booking_affiliate: {
    kind: "system",
    description: "Booking.com deep links on hotel POIs.",
    default: true,
  },
  sys_ride_publishing: {
    kind: "system",
    description: "Publishing rides (public/members).",
    default: true,
  },
  sys_community_collections: {
    kind: "system",
    description: "Community collections browsing.",
    default: true,
  },
  sys_poi_ratings: {
    kind: "system",
    description: "Rider ratings & stop reviews (US-25).",
    default: true,
  },
  sys_gamification: {
    kind: "system",
    description: "Badges, challenges, personal road map (Epic 7).",
    default: true,
  },
  sys_push_notifications: {
    kind: "system",
    description:
      "Non-critical push (marketing, engagement). Safety alerts are not behind this.",
    default: true,
  },
```

- [ ] **Step 5: Add the derived types/consts + guard + resolvers.** After the existing `LIMIT_FEATURE_KEYS` const add:

```ts
export type SystemFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "system"
    ? K
    : never;
}[FeatureKey];

export const SYSTEM_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is SystemFeatureKey => FEATURE_DEFINITIONS[key].kind === "system",
);

export type SystemSwitchSnapshot = Record<SystemFeatureKey, boolean>;
```

Add the guard after `isLimitFeatureKey`:

```ts
export function isSystemFeatureKey(value: unknown): value is SystemFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "system";
}
```

Add the resolvers near `buildLimitSnapshot`:

```ts
/**
 * Resolve one system switch. Pure. On by default; an operator `force_off`
 * is the only way off. `force_on`/absent resolve on.
 */
export function resolveSystemSwitch(
  key: SystemFeatureKey,
  globalState: GlobalFeatureState | undefined,
): boolean {
  void key; // key kept for signature symmetry; the default is always ON
  return globalState !== "force_off";
}

/** Resolve every registry system switch. Unknown keys in the state map are
 * ignored — only registry keys are iterated. */
export function buildSystemSwitchSnapshot(
  globalStates: Readonly<Partial<Record<string, GlobalFeatureState>>>,
): SystemSwitchSnapshot {
  const snapshot = {} as SystemSwitchSnapshot;
  for (const key of SYSTEM_FEATURE_KEYS) {
    snapshot[key] = resolveSystemSwitch(key, globalStates[key]);
  }
  return snapshot;
}
```

- [ ] **Step 6: Verify green**

Run: `pnpm --filter @tarmoto/shared test && pnpm shared:build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/feature-flags.ts packages/shared/src/feature-flags.spec.ts
git commit -m "feat(shared): system-switch registry kind (default-on, no tier) + 14 sys_* keys"
```

---

### Task 2: Backend resolver — `FeatureResolver.getSystemSwitches`

**Files:**

- Modify: `apps/backend/src/modules/features/feature-resolver.service.ts`
- Modify: `apps/backend/src/modules/features/feature-resolver.service.spec.ts`

**Interfaces:**

- Consumes: `buildSystemSwitchSnapshot`, `SystemSwitchSnapshot` (Task 1); existing `getGlobalStates()` on the resolver.
- Produces: `FeatureResolver.getSystemSwitches(): Promise<SystemSwitchSnapshot>`. Not called by any guard in this phase.

- [ ] **Step 1: Write the failing test.** In `feature-resolver.service.spec.ts` (it mocks the repositories), add a test: with a seeded `feature_states` row `{ feature: 'sys_weather_provider', state: 'force_off' }`, `getSystemSwitches()` returns that key `false` and another system key (e.g. `sys_mapillary_previews`) `true`.

```ts
it("getSystemSwitches resolves force_off to disabled and everything else on", async () => {
  featureStates.find.mockResolvedValue([
    { feature: "sys_weather_provider", state: "force_off" },
  ]);
  const switches = await resolver.getSystemSwitches();
  expect(switches.sys_weather_provider).toBe(false);
  expect(switches.sys_mapillary_previews).toBe(true);
});
```

(Use the spec's existing `featureStates` mock handle + `resolver` instance; match how the existing `getGlobalStates` test seeds `featureStates.find`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver`
Expected: FAIL — `getSystemSwitches` is not a function.

- [ ] **Step 3: Implement.** Add the import to the `@tarmoto/shared` import block: `buildSystemSwitchSnapshot`, `type SystemSwitchSnapshot`. Add the method (near `getGlobalStates`):

```ts
/**
 * Resolved system switches (operator kill toggles, default ON). Reads the
 * same global `feature_states` rows as `getGlobalStates` and folds them
 * through the pure `buildSystemSwitchSnapshot`. For the backend's own use
 * (and future per-subsystem enforcement) — not gated by any guard yet.
 */
async getSystemSwitches(): Promise<SystemSwitchSnapshot> {
  return buildSystemSwitchSnapshot(await this.getGlobalStates());
}
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/features/
git commit -m "feat(backend): FeatureResolver.getSystemSwitches (resolved kill-switch map)"
```

---

### Task 3: Backend admin surface — `/admin/system-switches`

**Files:**

- Create: `apps/backend/src/modules/admin-flags/dto/admin-system-switches.dto.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-system-switches.service.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-system-switches.controller.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-system-switches.service.spec.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-system-switches.controller.spec.ts`
- Create: `apps/backend/src/modules/admin-flags/dto/admin-system-switches.dto.spec.ts`
- Modify: `apps/backend/src/modules/admin/admin.module.ts` (register controller + service; `FeatureState` already in `forFeature`)

**Interfaces:**

- Consumes: `SYSTEM_FEATURE_KEYS`, `isSystemFeatureKey`, `resolveSystemSwitch`, `FEATURE_DEFINITIONS`, `type SystemFeatureKey` (shared); `FeatureState` entity; `AdminRoles`, `setAdminAuditTarget`, `AdminRequest` (existing admin plumbing — mirror `admin-limits.controller.ts`).
- Produces: `GET /admin/system-switches` → `AdminSystemSwitchesResponseDto`; `PUT /admin/system-switches/:key/disable` (body `SetSystemSwitchDisabledDto`) → `AdminSystemSwitchDto`; `DELETE /admin/system-switches/:key/disable` (204).

- [ ] **Step 1: Write the DTOs** (`admin-system-switches.dto.ts`):

```ts
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/** Admin wire shapes for system switches (operator kill toggles, default
 * ON). The switch vocabulary is code-defined (`FEATURE_DEFINITIONS`); the
 * only operator action is disable (write force_off) / enable (clear). */

export class AdminSystemSwitchDto {
  @ApiProperty({ description: "Registry system-switch key." })
  key!: string;

  @ApiProperty() description!: string;

  @ApiProperty({ description: "Resolved state — false when disabled." })
  enabled!: boolean;

  @ApiProperty({
    nullable: true,
    description: "Why it was disabled (only when disabled).",
  })
  disabled_reason!: string | null;

  @ApiProperty({ nullable: true }) disabled_by!: string | null;
  @ApiProperty({ nullable: true }) disabled_at!: string | null;
}

export class AdminSystemSwitchesResponseDto {
  @ApiProperty({ type: [AdminSystemSwitchDto] })
  switches!: AdminSystemSwitchDto[];
}

export class SetSystemSwitchDisabledDto {
  @ApiProperty({
    maxLength: 500,
    description:
      "Why the subsystem is being disabled — always required (a kill " +
      "switch must carry incident context). Stored on the row, not audited.",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
```

- [ ] **Step 2: Write failing service/controller/dto specs.** Mirror `admin-limits.service.spec.ts` / `admin-limits.controller.spec.ts` / `dto/admin-limits.dto.spec.ts`:
  - **service**: `listSwitches` returns all 14 keys, each `enabled` resolved (a seeded `force_off` row → `enabled:false` + reason/by/at populated; absent → `enabled:true`, nulls); `disableSwitch` upserts a `force_off` row with reason + `updated_by` and returns the refreshed dto (`enabled:false`); `enableSwitch` deletes the row (idempotent when absent); unknown key AND wrong-kind key (`gpx_export`, `max_active_trips`) ⇒ `BadRequestException`.
  - **dto spec** (plainToInstance + validate): `SetSystemSwitchDisabledDto` accepts `{reason:"x"}`; rejects missing/blank/whitespace reason; trims.
  - **controller**: role metadata (`support` read, `admin` writes), audit target set (`system_switch`), delegates to the service, `@HttpCode(204)` on delete.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns admin-system-switches`
Expected: FAIL — files don't exist.

- [ ] **Step 4: Implement the service** (`admin-system-switches.service.ts`):

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  FEATURE_DEFINITIONS,
  SYSTEM_FEATURE_KEYS,
  isSystemFeatureKey,
  resolveSystemSwitch,
  type SystemFeatureKey,
} from "@tarmoto/shared";
import { FeatureState } from "../../entities/feature-state.entity.js";
import {
  AdminSystemSwitchDto,
  AdminSystemSwitchesResponseDto,
  SetSystemSwitchDisabledDto,
} from "./dto/admin-system-switches.dto.js";

/**
 * Operator management for system switches (kill toggles, default ON). The
 * switch set is code-defined; operators only disable (write a `force_off`
 * row to the shared `feature_states` table) or enable (clear it). No tier,
 * no per-user layer.
 */
@Injectable()
export class AdminSystemSwitchesService {
  constructor(
    @InjectRepository(FeatureState)
    private readonly featureStates: Repository<FeatureState>,
  ) {}

  async listSwitches(): Promise<AdminSystemSwitchesResponseDto> {
    const rows = await this.featureStates.find();
    const byFeature = new Map(rows.map((r) => [r.feature, r]));
    const switches = SYSTEM_FEATURE_KEYS.map((key): AdminSystemSwitchDto => {
      const def = FEATURE_DEFINITIONS[key];
      const row = byFeature.get(key);
      const disabled = row?.state === "force_off";
      return {
        key,
        description: def.description,
        enabled: resolveSystemSwitch(key, row?.state),
        disabled_reason: disabled ? row!.reason : null,
        disabled_by: disabled ? row!.updated_by : null,
        disabled_at: disabled ? row!.updated_at.toISOString() : null,
      };
    });
    return { switches };
  }

  async disableSwitch(
    key: string,
    dto: SetSystemSwitchDisabledDto,
    adminUserId: string,
  ): Promise<AdminSystemSwitchDto> {
    const switchKey = this.assertKnownSwitch(key);
    const existing = await this.featureStates.findOne({
      where: { feature: switchKey },
    });
    const row = existing ?? this.featureStates.create({ feature: switchKey });
    row.state = "force_off";
    row.reason = dto.reason;
    row.updated_by = adminUserId;
    await this.featureStates.save(row);
    return this.switchDto(switchKey);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async enableSwitch(key: string): Promise<void> {
    const switchKey = this.assertKnownSwitch(key);
    await this.featureStates.delete({ feature: switchKey });
  }

  private async switchDto(
    key: SystemFeatureKey,
  ): Promise<AdminSystemSwitchDto> {
    const { switches } = await this.listSwitches();
    const found = switches.find((s) => s.key === key);
    if (!found) throw new NotFoundException("System switch not found");
    return found;
  }

  private assertKnownSwitch(key: string): SystemFeatureKey {
    if (!isSystemFeatureKey(key)) {
      throw new BadRequestException(`Unknown system switch: ${key}`);
    }
    return key;
  }
}
```

- [ ] **Step 5: Implement the controller** (`admin-system-switches.controller.ts`) — mirror `admin-limits.controller.ts` structure exactly:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdminRoles } from "../admin-auth/admin-role.decorator.js";
import type { AdminRequest } from "../admin/internal.guard.js";
import { setAdminAuditTarget } from "../admin/admin-audit-context.js";
import { AdminSystemSwitchesService } from "./admin-system-switches.service.js";
import {
  AdminSystemSwitchDto,
  AdminSystemSwitchesResponseDto,
  SetSystemSwitchDisabledDto,
} from "./dto/admin-system-switches.dto.js";

/**
 * Operator surface for system switches (kill toggles, default ON). The
 * switch set is code-defined — no create/delete; operators disable / enable
 * only. Reads open to support; mutations need the admin role.
 */
@ApiTags("admin")
@Controller("admin")
export class AdminSystemSwitchesController {
  constructor(private readonly service: AdminSystemSwitchesService) {}

  @Get("system-switches")
  @AdminRoles("support")
  @ApiOperation({ summary: "List the system switches with resolved state" })
  @ApiResponse({ status: 200, type: AdminSystemSwitchesResponseDto })
  list(): Promise<AdminSystemSwitchesResponseDto> {
    return this.service.listSwitches();
  }

  @Put("system-switches/:key/disable")
  @AdminRoles("admin")
  @ApiOperation({ summary: "Disable a subsystem (operator kill switch)" })
  @ApiResponse({ status: 200, type: AdminSystemSwitchDto })
  disable(
    @Req() req: AdminRequest,
    @Param("key") key: string,
    @Body() dto: SetSystemSwitchDisabledDto,
  ): Promise<AdminSystemSwitchDto> {
    setAdminAuditTarget(req, { target_type: "system_switch", target_id: key });
    return this.service.disableSwitch(key, dto, req.adminUser!.id);
  }

  @Delete("system-switches/:key/disable")
  @AdminRoles("admin")
  @HttpCode(204)
  @ApiOperation({ summary: "Re-enable a subsystem (clear the kill switch)" })
  enable(@Req() req: AdminRequest, @Param("key") key: string): Promise<void> {
    setAdminAuditTarget(req, { target_type: "system_switch", target_id: key });
    return this.service.enableSwitch(key);
  }
}
```

- [ ] **Step 6: Wire the module.** In `apps/backend/src/modules/admin/admin.module.ts`: import `AdminSystemSwitchesController` + `AdminSystemSwitchesService` (from `../admin-flags/…`), add the controller to `controllers` and the service to `providers`, next to the `AdminLimits*` entries. `FeatureState` is already in `TypeOrmModule.forFeature` — no change there.

- [ ] **Step 7: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns admin-system-switches && pnpm backend:build && pnpm backend:lint`
Expected: PASS (lint runs `--fix`; re-stage if it rewrites). Then run the full backend suite once (`pnpm --filter @tarmoto/backend test`) — PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/admin-flags/ apps/backend/src/modules/admin/admin.module.ts
git commit -m "feat(backend): admin system-switch surface (disable/enable kill toggles)"
```

---

### Task 4: Contract regen + client typechecks

**Files:**

- Regenerated: `packages/openapi/openapi.yaml` (+ Postman), `packages/openapi-client/src/generated/schema.d.ts`
- Modify: only if a typecheck surfaces a fixture needing the new types (none expected — system switches add no field to existing DTOs).

**Interfaces:**

- Consumes: the Task 3 admin endpoints.
- Produces: regenerated `components["schemas"]["AdminSystemSwitchDto"]` etc. for the Task 5 hooks.

- [ ] **Step 1: Regenerate**

Run: `pnpm openapi:gen && pnpm postman:gen && (cd packages/openapi-client && pnpm generate) && pnpm --filter @tarmoto/openapi test`
Expected: PASS; `git diff --stat packages/openapi-client/src/generated/schema.d.ts` shows the new `AdminSystemSwitch*` schemas + `/admin/system-switches` paths. Existing schemas unchanged (additive).

- [ ] **Step 2: Typecheck consumers**

Run: `pnpm --filter @tarmoto/admin typecheck && (cd apps/companion && npx tsc --noEmit) && (cd apps/mobile && npx tsc --noEmit)`
Expected: PASS (no fixture changes expected — the change is purely additive new endpoints).

- [ ] **Step 3: Commit**

```bash
git add packages/openapi packages/openapi-client
git commit -m "feat(openapi): regenerate contract with admin system-switch endpoints"
```

---

### Task 5: Admin UI — `SystemSwitchesCard` on the Feature Flags screen

**Files:**

- Modify: `apps/admin/src/data/useAdminFlags.ts` (add 3 hooks)
- Modify: `apps/admin/src/screens/FeatureFlagsScreen.tsx` (add `SystemSwitchesCard`, rendered from `FeatureFlagsScreen` below the existing cards)
- Modify: `apps/admin/src/screens/FeatureFlagsScreen.test.tsx`

**Interfaces:**

- Consumes: regenerated `components["schemas"]["AdminSystemSwitchDto"]`; `@tarmoto/ui` (`DataTable`, `Pill`, `Button`, `Alert`, `Textarea`), local `Dialog`, the existing `readErrorMessage` helper.
- Produces hooks: `useAdminSystemSwitches()`, `useDisableSystemSwitch()`, `useEnableSystemSwitch()`.

- [ ] **Step 1: Add the hooks** (append to `useAdminFlags.ts`, same thin `$api` idiom as the limit hooks):

```ts
export function useAdminSystemSwitches() {
  return $api.useQuery("get", "/admin/system-switches");
}

export function useDisableSystemSwitch() {
  return $api.useMutation("put", "/admin/system-switches/{key}/disable");
}

export function useEnableSystemSwitch() {
  return $api.useMutation("delete", "/admin/system-switches/{key}/disable");
}
```

- [ ] **Step 2: Write failing screen tests.** Extend `FeatureFlagsScreen.test.tsx` (mock the 3 new hooks in the existing `../data/useAdminFlags.js` mock): renders a "System switches" card with a `sys_weather_provider` row showing resolved state (a Pill: "On"/"Disabled"); an on switch offers **Disable** which opens a dialog whose submit (with a reason) fires `useDisableSystemSwitch().mutate` with `{ params: { path: { key: "sys_weather_provider" } }, body: { reason } }`; a disabled switch shows its reason + an **Enable** action firing `useEnableSystemSwitch().mutate`; submitting Disable with a blank reason does not call mutate + shows an error.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @tarmoto/admin exec vitest run FeatureFlagsScreen`
(NOT `pnpm admin:test -- X` — the admin test script is compound.)
Expected: FAIL.

- [ ] **Step 4: Implement `SystemSwitchesCard`** inside `FeatureFlagsScreen.tsx`, rendered from `FeatureFlagsScreen` below the Limits card. Mirror `FeatureLimitsCard`'s structure (`pendingKey` state, `readErrorMessage`, `Dialog` with a mandatory-reason form, `DataTable`). Type rows as `components["schemas"]["AdminSystemSwitchDto"]`. Columns: `key` (primary), `description`, a **State** column rendering `<Pill variant={row.enabled ? "ghost" : "warning"}>{row.enabled ? "On" : "Disabled"}</Pill>` plus the `disabled_reason` under it when disabled, and an **actions** column: an on switch shows a "Disable" button (opens the reason dialog); a disabled switch shows "Enable" (fires the clear mutation), both `disabled`/`loading` while `pendingKey === row.key`. The disable dialog is a form with a required `Textarea` reason; submit validates non-blank (mirror the flags screen's force-off dialog), then `disableMutation.mutate({ params: { path: { key: target.key } }, body: { reason: trimmedReason } }, { onSuccess: () => { close; refetch }, onError: setDialogError })`. Full handlers, matching the FeatureLimitsCard idioms already in this file.

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @tarmoto/admin exec vitest run FeatureFlagsScreen && pnpm --filter @tarmoto/admin typecheck && pnpm --filter @tarmoto/admin lint`
Then the full admin suite once: `pnpm admin:test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/data/useAdminFlags.ts apps/admin/src/screens/FeatureFlagsScreen.tsx apps/admin/src/screens/FeatureFlagsScreen.test.tsx
git commit -m "feat(admin): system switches card with disable/enable management"
```

---

### Task 6: Full-repo validation + PR

**Files:** none new — verification only.

- [ ] **Step 1: Full builds + suites**

Run (each must PASS):

```bash
pnpm --filter @tarmoto/shared test && pnpm shared:build
pnpm openapi:gen && pnpm postman:gen
pnpm backend:lint && pnpm --filter @tarmoto/backend test && pnpm backend:build
pnpm --filter @tarmoto/admin exec vitest run && pnpm --filter @tarmoto/admin typecheck && pnpm admin:test
(cd apps/companion && npx tsc --noEmit) && (cd apps/mobile && npx tsc --noEmit)
```

- [ ] **Step 2: Spec conformance sweep** — re-read `docs/superpowers/specs/2026-07-18-system-switches-design.md` §3 and confirm each clause landed: default-on/no-tier registry kind, `resolveSystemSwitch`, `buildSystemSwitchSnapshot`, `getSystemSwitches`, no migration/no seed, `TOGGLE_`/`LIMIT_FEATURE_KEYS` unchanged (grep `buildFeatureSnapshot` still iterates only toggles; `FeatureSnapshotDto`/`LimitSnapshotDto` untouched), no enforcement guard added for a `sys_*` key, dedicated admin surface reason-required + audit target `system_switch`, additive contract (only new `/admin/system-switches` paths).

- [ ] **Step 3: Diff review** — `git diff main...HEAD` for debug leftovers, dead code, `.js` import suffixes, no accidental change to entitlement resolution or DTOs, Postman churn cleaned (`git checkout -- packages/openapi/postman/` if only formatting/UUID churn remains).

- [ ] **Step 4: Push + PR** — push `feat/system-switches`, open a PR against `main` (title `feat(cross): system switches — feature-flag catalog phase 2`), body covering: what it adds (mechanism + admin, 14 sys\_\* switches), the deliberate no-enforcement/no-migration scope, additive contract, and test evidence. Label `cross`.

---

## Execution notes

- Tasks are ordered; each consumes the previous. Task 5 depends on Task 4's regenerated types.
- No migration and no seed anywhere — if any step wants to add one, stop: default-on means no rows until an operator disables a switch.
- The whole point is that `TOGGLE_FEATURE_KEYS`/`LIMIT_FEATURE_KEYS` and the entitlement snapshot are untouched — if a shared or backend test about `buildFeatureSnapshot`/`FeatureSnapshotDto` starts failing, the registry change leaked into the toggle path; fix the leak, don't edit the entitlement test.
- After any main-merge during execution, run `pnpm shared:build` before trusting local eslint (stale `@tarmoto/shared` dist → phantom "type could not be resolved").
