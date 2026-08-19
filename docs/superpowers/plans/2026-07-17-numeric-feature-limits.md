# Numeric Feature Limits (Tier Entitlements v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add universal numeric ("limit") entitlements to the tier feature-flag system — registry, resolution, storage, wire, admin — and enforce the first limit, `max_active_trips`, in the trips service.

**Architecture:** One unified registry (`FEATURE_DEFINITIONS`) where every key declares `kind: "toggle" | "limit"`, with kind-split wire types (`features` boolean map unchanged; new additive `limits` map). Two new tables (`user_limits`, `limit_states`) mirror the boolean override pair; `FeatureResolver` grows limit layers; admin gets twin endpoints/UI; trips enforcement is a service-level count check. Spec: `docs/superpowers/specs/2026-07-17-numeric-feature-limits-design.md` (read it first).

**Tech Stack:** TypeScript strict everywhere; shared = vitest; backend = NestJS 11 + TypeORM + jest 30 (`--testPathPatterns`); admin = Vite SPA + vitest + `@tarmoto/ui` + openapi-react-query (`$api`); OpenAPI regen via `pnpm openapi:gen`.

## Global Constraints

- **`null` means unlimited** at every layer (registry, DB, wire, checks). Missing/absent must always resolve to the most-restrictive fallback, never unlimited.
- Limit resolution precedence: tier value (or registry `default` for unknown tier) → per-user override replaces → global override replaces the tier layer, but when a per-user override exists the **more restrictive** of (per-user, global) wins (`min`, null = ∞).
- Wire contract changes are **additive only**. `FeatureSnapshotDto` and `GET /config/flags` keep their exact shapes. Global limit overrides ship on a NEW `GET /config/limits` endpoint (the `/config/flags` response is itself a flat map and cannot gain a `limits` key).
- Repo must be green (build + typecheck + tests) after EVERY task's commit — shared type changes and their backend re-points land in the same commit.
- Conventional commits, lowercase subjects, scope required (`shared`, `backend`, `openapi`, `cross`). End commit bodies with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No broad try/catch; no silent fallbacks. TypeScript strict mode; backend ESM imports use `.js` suffixes.
- After backend DTO/endpoint changes: `pnpm openapi:gen` must pass (it is also the strict-tsc oracle: local `nest build` misses `noUncheckedIndexedAccess` errors CI catches there) and `pnpm postman:gen` must be run.
- Migrations MUST be registered in BOTH `apps/backend/src/data-source.ts` and `apps/backend/src/modules/database/database.module.ts` (entity lists too); `migration-registry.spec.ts` enforces the data-source half.
- Prettier runs via lint-staged on commit — don't hand-fight formatting.

---

### Task 1: Shared registry union (`kind: toggle | limit`) + backend re-points

The registry becomes a discriminated union and the key list gains kind-split arrays. Backend sites that assume "every key is a toggle" are re-pointed in the same commit so the repo stays green.

**Files:**

- Modify: `packages/shared/src/feature-flags.ts`
- Modify: `packages/shared/src/feature-flags.spec.ts`
- Modify: `apps/backend/src/modules/admin-flags/admin-flags.service.ts` (FEATURE_KEYS → TOGGLE_FEATURE_KEYS, isFeatureKey → isToggleFeatureKey, FeatureKey → ToggleFeatureKey)
- Modify: `apps/backend/src/modules/features/require-feature.decorator.ts` (FeatureKey → ToggleFeatureKey)
- Modify: `apps/backend/src/modules/features/feature.guard.ts` (FeatureKey → ToggleFeatureKey)
- Modify: `apps/backend/src/modules/features/feature-test-providers.ts` (FEATURE_KEYS → TOGGLE_FEATURE_KEYS)

**Interfaces:**

- Consumes: existing `SubscriptionTier`, `SUBSCRIPTION_TIERS` from `./constants.js`.
- Produces (later tasks rely on these exact names): `ToggleFeatureDefinition`, `LimitFeatureDefinition`, `FeatureDefinition` (union), `FEATURE_DEFINITIONS`, `FeatureKey`, `ToggleFeatureKey`, `LimitFeatureKey`, `FEATURE_KEYS`, `TOGGLE_FEATURE_KEYS`, `LIMIT_FEATURE_KEYS`, `isToggleFeatureKey(v): v is ToggleFeatureKey`, `isLimitFeatureKey(v): v is LimitFeatureKey`, `FeatureSnapshot = Record<ToggleFeatureKey, boolean>`, `LimitSnapshot = Record<LimitFeatureKey, number | null>`. `resolveFeature`/`buildFeatureSnapshot` now accept/iterate toggle keys only; signatures otherwise unchanged.

- [ ] **Step 1: Write the failing tests** — in `packages/shared/src/feature-flags.spec.ts`, add a `describe("kind-split registry")` block and update the three existing tests that iterate `FEATURE_KEYS` assuming toggles:

```ts
import {
  FEATURE_DEFINITIONS,
  FEATURE_KEYS,
  LIMIT_FEATURE_KEYS,
  TOGGLE_FEATURE_KEYS,
  buildFeatureSnapshot,
  isFeatureKey,
  isLimitFeatureKey,
  isToggleFeatureKey,
  resolveFeature,
} from "./feature-flags";

describe("kind-split registry", () => {
  it("partitions FEATURE_KEYS exactly into toggle + limit keys", () => {
    expect([...TOGGLE_FEATURE_KEYS, ...LIMIT_FEATURE_KEYS].sort()).toEqual(
      [...FEATURE_KEYS].sort(),
    );
    for (const key of TOGGLE_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("toggle");
    }
    for (const key of LIMIT_FEATURE_KEYS) {
      expect(FEATURE_DEFINITIONS[key].kind).toBe("limit");
    }
  });

  it("defines max_active_trips as a limit (free=1, pro/premium unlimited)", () => {
    expect(FEATURE_DEFINITIONS.max_active_trips).toEqual({
      kind: "limit",
      description: "Maximum open (draft/planned/active) trips a user may own.",
      default: 1,
      tiers: { free: 1, pro: null, premium: null },
    });
  });

  it("limit values are monotone non-decreasing across the tier ladder", () => {
    const rank = (v: number | null) => (v === null ? Infinity : v);
    for (const key of LIMIT_FEATURE_KEYS) {
      const { tiers } = FEATURE_DEFINITIONS[key];
      expect(rank(tiers.free)).toBeLessThanOrEqual(rank(tiers.pro));
      expect(rank(tiers.pro)).toBeLessThanOrEqual(rank(tiers.premium));
    }
  });

  it("key guards discriminate by kind", () => {
    expect(isToggleFeatureKey("gpx_export")).toBe(true);
    expect(isToggleFeatureKey("max_active_trips")).toBe(false);
    expect(isLimitFeatureKey("max_active_trips")).toBe(true);
    expect(isLimitFeatureKey("gpx_export")).toBe(false);
    expect(isFeatureKey("max_active_trips")).toBe(true);
    expect(isLimitFeatureKey("nope")).toBe(false);
  });
});
```

Update existing tests (same file) that iterate all keys as toggles — they must iterate `TOGGLE_FEATURE_KEYS` instead of `FEATURE_KEYS`:

- `"every definition's tier allowlist uses known tiers only"` (accesses `.tiers` as an array)
- `"free-tier grants are also granted to every paid tier (no downgrade holes)"`
- `"falls back to the registry default..."` in `resolveFeature precedence` and every other `resolveFeature`/`buildFeatureSnapshot` loop over `FEATURE_KEYS`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/shared test`
Expected: FAIL — `TOGGLE_FEATURE_KEYS` / `isToggleFeatureKey` not exported; `max_active_trips` missing.

- [ ] **Step 3: Rewrite the registry core** in `packages/shared/src/feature-flags.ts`. Replace the `FEATURE_KEYS` const, `FeatureKey` type, `FeatureDefinition` interface, and `FEATURE_DEFINITIONS` with (keep the existing file-top doc comment, extend it with one sentence about limit kinds and null=unlimited):

```ts
export interface ToggleFeatureDefinition {
  kind: "toggle";
  /** Operator-facing description shown in the admin console. */
  description: string;
  /** Baseline value before tier grants and overrides apply. */
  default: boolean;
  /** Tiers granted the feature (allowlist — only ever flips a flag ON). */
  tiers: readonly SubscriptionTier[];
}

export interface LimitFeatureDefinition {
  kind: "limit";
  description: string;
  /** Value applied when the tier is unknown/invalid. `null` = unlimited. */
  default: number | null;
  /** Explicit per-tier values — no allowlist ambiguity for numbers. */
  tiers: Readonly<Record<SubscriptionTier, number | null>>;
}

export type FeatureDefinition =
  ToggleFeatureDefinition | LimitFeatureDefinition;

const ALL_TIERS = ["free", "pro", "premium"] as const;
const PRO_AND_UP = ["pro", "premium"] as const;
const PREMIUM_ONLY = ["premium"] as const;

export const FEATURE_DEFINITIONS = {
  // ── Free (granted to every tier) ──
  basic_navigation: {
    kind: "toggle",
    description: "Basic turn-by-turn navigation.",
    default: false,
    tiers: ALL_TIERS,
  },
  road_quality_overlay: {
    kind: "toggle",
    description: "Road quality overlay (limited zoom on the free tier).",
    default: false,
    tiers: ALL_TIERS,
  },
  hazard_alerts: {
    kind: "toggle",
    description: "Community hazard alerts.",
    default: false,
    tiers: ALL_TIERS,
  },
  // ── Pro (€29.99/yr) ──
  unlimited_trip_planning: {
    kind: "toggle",
    description:
      "Unlimited trip planning (the free tier is capped at 1 active trip).",
    default: false,
    tiers: PRO_AND_UP,
  },
  full_road_quality_zoom: {
    kind: "toggle",
    description: "Full-depth road quality zoom.",
    default: false,
    tiers: PRO_AND_UP,
  },
  offline_maps: {
    kind: "toggle",
    description: "Offline map downloads.",
    default: false,
    tiers: PRO_AND_UP,
  },
  gpx_export: {
    kind: "toggle",
    description: "GPX export of recorded rides.",
    default: false,
    tiers: PRO_AND_UP,
  },
  commuter_mode: {
    kind: "toggle",
    description:
      "Commuter mode — saved commute routes, status and alternatives.",
    default: false,
    tiers: PRO_AND_UP,
  },
  // ── Premium (€49.99/yr) ──
  group_rides: {
    kind: "toggle",
    description: "Real-time group rides (unlimited).",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  priority_hazard_alerts: {
    kind: "toggle",
    description: "Priority hazard alert delivery.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  advanced_analytics: {
    kind: "toggle",
    description: "Advanced riding analytics dashboard.",
    default: false,
    tiers: PREMIUM_ONLY,
  },
  // ── Limits (numeric entitlements; null = unlimited) ──
  max_active_trips: {
    kind: "limit",
    description: "Maximum open (draft/planned/active) trips a user may own.",
    default: 1,
    tiers: { free: 1, pro: null, premium: null },
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURE_DEFINITIONS;

export type ToggleFeatureKey = {
  [K in FeatureKey]: (typeof FEATURE_DEFINITIONS)[K]["kind"] extends "toggle"
    ? K
    : never;
}[FeatureKey];

export type LimitFeatureKey = Exclude<FeatureKey, ToggleFeatureKey>;

export const FEATURE_KEYS = Object.keys(
  FEATURE_DEFINITIONS,
) as readonly FeatureKey[];

export const TOGGLE_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is ToggleFeatureKey => FEATURE_DEFINITIONS[key].kind === "toggle",
);

export const LIMIT_FEATURE_KEYS = FEATURE_KEYS.filter(
  (key): key is LimitFeatureKey => FEATURE_DEFINITIONS[key].kind === "limit",
);
```

Then adjust the existing surrounding code in the same file:

- `FeatureSnapshot` becomes `Record<ToggleFeatureKey, boolean>`; add `export type LimitSnapshot = Record<LimitFeatureKey, number | null>;` next to it.
- `resolveFeature(key: ToggleFeatureKey, …)` — change the key param type; inside, keep the logic but widen the tuple before `.includes`:

```ts
export function resolveFeature(
  key: ToggleFeatureKey,
  tier: string | null,
  override: boolean | undefined,
  globalState: GlobalFeatureState | undefined,
): boolean {
  const def = FEATURE_DEFINITIONS[key];
  let value = def.default;
  const grantTiers: readonly SubscriptionTier[] = def.tiers;
  if (isSubscriptionTier(tier) && grantTiers.includes(tier)) {
    value = true;
  }
  if (override !== undefined) {
    value = override;
  }
  if (globalState === "force_off") {
    return false;
  }
  if (globalState === "force_on" && override !== false) {
    value = true;
  }
  return value;
}
```

- `buildFeatureSnapshot` — iterate `TOGGLE_FEATURE_KEYS` instead of `FEATURE_KEYS` (body otherwise identical).
- Add the kind guards after `isFeatureKey` (which stays unchanged):

```ts
export function isToggleFeatureKey(value: unknown): value is ToggleFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "toggle";
}

export function isLimitFeatureKey(value: unknown): value is LimitFeatureKey {
  return isFeatureKey(value) && FEATURE_DEFINITIONS[value].kind === "limit";
}
```

- [ ] **Step 4: Re-point the backend toggle sites** (mechanical, no behavior change):
  - `apps/backend/src/modules/admin-flags/admin-flags.service.ts`: import `TOGGLE_FEATURE_KEYS`, `isToggleFeatureKey`, `type ToggleFeatureKey` (replacing `FEATURE_KEYS`, `isFeatureKey`, `type FeatureKey`); `listFlags()` and `getUserFlags()` map over `TOGGLE_FEATURE_KEYS`; `flagDto(feature: ToggleFeatureKey)`; `assertKnownFeature(feature: string): ToggleFeatureKey` uses `isToggleFeatureKey` (so `PUT /admin/feature-flags/max_active_trips/global` now 400s — correct; limits get their own endpoints in Task 7).
  - `apps/backend/src/modules/features/require-feature.decorator.ts` + `feature.guard.ts`: `FeatureKey` type imports become `ToggleFeatureKey`.
  - `apps/backend/src/modules/features/feature-test-providers.ts`: `FEATURE_KEYS` → `TOGGLE_FEATURE_KEYS`.

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @tarmoto/shared test && pnpm shared:build && pnpm --filter @tarmoto/backend test -- --testPathPatterns 'feature|admin-flags' && pnpm backend:build`
Expected: PASS (all suites; build clean).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/feature-flags.ts packages/shared/src/feature-flags.spec.ts apps/backend/src/modules/admin-flags/admin-flags.service.ts apps/backend/src/modules/features/
git commit -m "feat(shared): kind-split feature registry (toggle | limit) + max_active_trips entry"
```

---

### Task 2: Shared limit resolution helpers

**Files:**

- Modify: `packages/shared/src/feature-flags.ts`
- Modify: `packages/shared/src/feature-flags.spec.ts`

**Interfaces:**

- Consumes: `FEATURE_DEFINITIONS`, `LIMIT_FEATURE_KEYS`, `LimitFeatureKey`, `LimitSnapshot`, `isSubscriptionTier` from Task 1.
- Produces: `resolveLimit(key: LimitFeatureKey, tier: string | null, override: number | null | undefined, globalOverride: number | null | undefined): number | null`; `buildLimitSnapshot(tier, overrides, globalOverrides): LimitSnapshot`; `getFeatureLimit(limits, key, fallback?): number | null`; `isWithinLimit(limit: number | null, currentCount: number): boolean`; `type GlobalLimitOverrides = Partial<Record<string, number | null>>`. In override maps, `undefined`/absent = no override; `null` = unlimited.

- [ ] **Step 1: Write the failing tests** (append to `feature-flags.spec.ts`):

```ts
import {
  buildLimitSnapshot,
  getFeatureLimit,
  isWithinLimit,
  resolveLimit,
} from "./feature-flags";

describe("resolveLimit precedence", () => {
  it("uses the tier value; registry default for unknown tiers", () => {
    expect(resolveLimit("max_active_trips", "free", undefined, undefined)).toBe(
      1,
    );
    expect(
      resolveLimit("max_active_trips", "pro", undefined, undefined),
    ).toBeNull();
    expect(
      resolveLimit("max_active_trips", "premium", undefined, undefined),
    ).toBeNull();
    expect(resolveLimit("max_active_trips", null, undefined, undefined)).toBe(
      1,
    );
    expect(
      resolveLimit("max_active_trips", "hacked", undefined, undefined),
    ).toBe(1);
  });

  it("per-user override replaces the tier value in both directions", () => {
    expect(resolveLimit("max_active_trips", "free", 10, undefined)).toBe(10);
    expect(resolveLimit("max_active_trips", "pro", 0, undefined)).toBe(0);
    expect(
      resolveLimit("max_active_trips", "free", null, undefined),
    ).toBeNull();
  });

  it("global override replaces the tier layer for users without an override", () => {
    expect(
      resolveLimit("max_active_trips", "free", undefined, null),
    ).toBeNull();
    expect(resolveLimit("max_active_trips", "pro", undefined, 3)).toBe(3);
  });

  it("an explicit per-user restriction survives a global raise (min wins)", () => {
    // launch mode (global null = unlimited) must not disarm "this spammer gets 0"
    expect(resolveLimit("max_active_trips", "free", 0, null)).toBe(0);
  });

  it("a global clamp beats a support-raised user (min wins)", () => {
    expect(resolveLimit("max_active_trips", "free", 10, 3)).toBe(3);
    expect(resolveLimit("max_active_trips", "free", null, 3)).toBe(3);
  });
});

describe("buildLimitSnapshot", () => {
  it("resolves every limit key", () => {
    const snapshot = buildLimitSnapshot("free", {}, {});
    expect(Object.keys(snapshot).sort()).toEqual(
      [...LIMIT_FEATURE_KEYS].sort(),
    );
    expect(snapshot.max_active_trips).toBe(1);
  });

  it("ignores unknown keys in override maps (stale rows never widen the set)", () => {
    const snapshot = buildLimitSnapshot(
      "free",
      { ghost_limit: null },
      { other_ghost: null },
    );
    expect(snapshot).toEqual({ max_active_trips: 1 });
  });

  it("combines all layers", () => {
    expect(
      buildLimitSnapshot(
        "free",
        { max_active_trips: 5 },
        { max_active_trips: 2 },
      ).max_active_trips,
    ).toBe(2);
  });
});

describe("getFeatureLimit", () => {
  it("reads a present value including null (unlimited)", () => {
    expect(getFeatureLimit({ max_active_trips: 4 }, "max_active_trips")).toBe(
      4,
    );
    expect(
      getFeatureLimit({ max_active_trips: null }, "max_active_trips"),
    ).toBeNull();
  });

  it("missing keys return the most-restrictive fallback, never unlimited", () => {
    expect(getFeatureLimit({}, "max_active_trips")).toBe(0);
    expect(getFeatureLimit({}, "max_active_trips", 1)).toBe(1);
  });

  it("prototype-collision keys fall back", () => {
    expect(getFeatureLimit({}, "toString")).toBe(0);
    expect(getFeatureLimit({}, "constructor")).toBe(0);
  });
});

describe("isWithinLimit", () => {
  it("null is always within (unlimited)", () => {
    expect(isWithinLimit(null, 10_000)).toBe(true);
  });
  it("true strictly below the limit, false at or above it", () => {
    expect(isWithinLimit(1, 0)).toBe(true);
    expect(isWithinLimit(1, 1)).toBe(false);
    expect(isWithinLimit(1, 2)).toBe(false);
    expect(isWithinLimit(0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/shared test`
Expected: FAIL — `resolveLimit` etc. not exported.

- [ ] **Step 3: Implement** (append to `feature-flags.ts`, after the toggle helpers):

```ts
/**
 * Global limit overrides currently in force, keyed by feature — the
 * response of `GET /api/v1/config/limits`. `null` = unlimited. Clients
 * may apply a value from this map only as a DOWNWARD clamp
 * (`effective = min(snapshot, global)`, null = ∞); raising is resolved
 * only by the authenticated `/users/me` snapshot.
 */
export type GlobalLimitOverrides = Partial<Record<string, number | null>>;

/** min() with `null` = unlimited (∞). */
function minLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Resolve one numeric limit for one user. Pure. Precedence:
 *   1. registry tier value (or `default` for unknown tiers)
 *   2. per-user override — replaces (support can raise or restrict)
 *   3. global override — replaces the tier layer; where a per-user
 *      override also exists, the more restrictive of the two wins.
 * `undefined` = no override; `null` = unlimited.
 */
export function resolveLimit(
  key: LimitFeatureKey,
  tier: string | null,
  override: number | null | undefined,
  globalOverride: number | null | undefined,
): number | null {
  const def = FEATURE_DEFINITIONS[key];
  let value: number | null = isSubscriptionTier(tier)
    ? def.tiers[tier]
    : def.default;
  if (override !== undefined) {
    value = override;
  }
  if (globalOverride !== undefined) {
    value =
      override !== undefined
        ? minLimit(override, globalOverride)
        : globalOverride;
  }
  return value;
}

/** Resolve every registry limit into a snapshot. Unknown keys in the
 * override maps are ignored — stale DB rows can never widen the set. */
export function buildLimitSnapshot(
  tier: string | null,
  overrides: Readonly<Partial<Record<string, number | null>>>,
  globalOverrides: Readonly<Partial<Record<string, number | null>>>,
): LimitSnapshot {
  const snapshot = {} as LimitSnapshot;
  for (const key of LIMIT_FEATURE_KEYS) {
    snapshot[key] = resolveLimit(
      key,
      tier,
      overrides[key],
      globalOverrides[key],
    );
  }
  return snapshot;
}

/**
 * Read a resolved limit safely from an untyped map (e.g. a cached
 * snapshot). Missing keys return `fallback` (default 0 — the most
 * restrictive value), never unlimited. Own-property guarded so
 * inherited prototype keys can't leak a value.
 */
export function getFeatureLimit(
  limits: Readonly<Partial<Record<string, number | null>>>,
  key: string,
  fallback: number | null = 0,
): number | null {
  if (!Object.hasOwn(limits, key)) return fallback;
  const value = limits[key];
  return value === undefined ? fallback : value;
}

/** True when `currentCount` leaves room for one more (`null` = unlimited). */
export function isWithinLimit(
  limit: number | null,
  currentCount: number,
): boolean {
  return limit === null || currentCount < limit;
}
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/shared test && pnpm shared:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/feature-flags.ts packages/shared/src/feature-flags.spec.ts
git commit -m "feat(shared): resolveLimit + limit snapshot helpers (null = unlimited, min-clamp global)"
```

---

### Task 3: Backend entities + migration (with launch-mode seed)

**Files:**

- Create: `apps/backend/src/entities/user-limit.entity.ts`
- Create: `apps/backend/src/entities/limit-state.entity.ts`
- Create: `apps/backend/src/migrations/1812000000000-AddLimitEntitlements.ts`
- Modify: `apps/backend/src/data-source.ts` (entities + migrations arrays; import lines follow the existing 1811 pattern)
- Modify: `apps/backend/src/modules/database/database.module.ts` (BOTH entity lists + migration list — mirror where `UserFeature`/`FeatureState` and `AddRoadQualitySeed1811000000000` appear)

**Interfaces:**

- Produces: `UserLimit` entity (table `user_limits`: `user_id`, `feature`, `value: number | null`, unique `(user_id, feature)`), `LimitState` entity (table `limit_states`: unique `feature`, `value: number | null`, `reason`, `updated_by`). Row presence = override; `value NULL` = unlimited.

- [ ] **Step 1: Write the entities.** `user-limit.entity.ts` (mirror `user-feature.entity.ts`'s imports/decorators exactly):

```ts
/**
 * Per-user numeric limit override. Presence of a row is the override:
 * `value` replaces the tier value (`NULL` = unlimited); no row means the
 * user resolves via registry tier value. The limit vocabulary is
 * code-defined in `FEATURE_DEFINITIONS` (`@tarmoto/shared`) — rows with
 * keys that leave the registry are simply ignored by the resolver.
 */
@Entity("user_limits")
@Unique("uq_user_limits_user_feature", ["user_id", "feature"])
@Index("idx_user_limits_feature", ["feature"])
export class UserLimit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid" })
  user_id!: string;

  @Column({ type: "varchar", length: 64 })
  feature!: string;

  @Column({ type: "integer", nullable: true })
  value!: number | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;
}
```

`limit-state.entity.ts` (mirror `feature-state.entity.ts`):

```ts
/**
 * Global limit override. One row per feature key; absence means the
 * limit resolves normally (tier value + per-user override). The value
 * replaces the tier layer for everyone (`NULL` = unlimited — launch
 * mode); an explicit per-user override still wins when it is MORE
 * restrictive (min). Seeded `('max_active_trips', NULL)` at migration
 * time so tier caps stay dark until monetization goes live.
 */
@Entity("limit_states")
@Index("uq_limit_states_feature", ["feature"], { unique: true })
export class LimitState {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  feature!: string;

  @Column({ type: "integer", nullable: true })
  value!: number | null;

  /** Why the override was set — required on write (any global limit
   * change is user-visible). Stored here, kept out of the audit log. */
  @Column({ type: "varchar", length: 500, nullable: true })
  reason!: string | null;

  /** Admin user id that last set the override. */
  @Column({ type: "uuid", nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}
```

- [ ] **Step 2: Write the migration** `1812000000000-AddLimitEntitlements.ts` (class `AddLimitEntitlements1812000000000`, doc comment explaining the pair + seed, mirroring 1795):

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE user_limits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      feature VARCHAR(64) NOT NULL,
      value INTEGER CHECK (value IS NULL OR value >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_user_limits_user_feature UNIQUE (user_id, feature)
    );
    CREATE INDEX idx_user_limits_feature ON user_limits (feature);

    CREATE TABLE limit_states (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feature VARCHAR(64) NOT NULL,
      value INTEGER CHECK (value IS NULL OR value >= 0),
      reason VARCHAR(500),
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_limit_states_feature ON limit_states (feature);

    INSERT INTO limit_states (feature, value, reason)
    VALUES ('max_active_trips', NULL, 'Launch mode: unlimited for everyone until tier enforcement goes live.')
    ON CONFLICT DO NOTHING;
  `);
}

public async down(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    DROP TABLE IF EXISTS limit_states CASCADE;
    DROP TABLE IF EXISTS user_limits CASCADE;
  `);
}
```

- [ ] **Step 3: Register everywhere.** Add `UserLimit` + `LimitState` next to `UserFeature`/`FeatureState` in `data-source.ts` `entities:` AND in both entity lists in `database.module.ts`; add `AddLimitEntitlements1812000000000` to the end of both `migrations:` arrays (imports mirror the 1811 lines).

- [ ] **Step 4: Verify** — the registry spec is the orphan guard:

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns migration-registry && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: (If local Docker DB is running)** `pnpm db:migrate` — expect `AddLimitEntitlements1812000000000` to run and `limit_states` to contain the seeded row. Skip if no local DB; say so in the report.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/user-limit.entity.ts apps/backend/src/entities/limit-state.entity.ts apps/backend/src/migrations/1812000000000-AddLimitEntitlements.ts apps/backend/src/data-source.ts apps/backend/src/modules/database/database.module.ts
git commit -m "feat(backend): user_limits + limit_states tables with launch-mode seed"
```

---

### Task 4: FeatureResolver limit layers

**Files:**

- Modify: `apps/backend/src/modules/features/feature-resolver.service.ts`
- Modify: `apps/backend/src/modules/features/features.module.ts` (add `UserLimit`, `LimitState` to `TypeOrmModule.forFeature`)
- Modify: `apps/backend/src/modules/features/feature-resolver.service.spec.ts`

**Interfaces:**

- Consumes: `buildLimitSnapshot`, `LimitSnapshot`, `GlobalLimitOverrides` (Task 2); `UserLimit`, `LimitState` (Task 3).
- Produces (later tasks call these):
  - `resolveLimitsForUser(userId: string): Promise<LimitSnapshot>` (Task 8 — trips)
  - `resolveEntitlementsForLoadedUser(user: Pick<User, 'id' | 'subscription_tier'>): Promise<UserEntitlements>` where `export interface UserEntitlements { features: FeatureSnapshot; limits: LimitSnapshot }` — **replaces** `resolveForLoadedUser` (its only callers are the 4 sites migrated in Task 5)
  - `getGlobalLimitOverrides(): Promise<GlobalLimitOverrides>` (Task 6 — config)
  - `resolveForUser` (guard path) unchanged.

- [ ] **Step 1: Write the failing tests.** Extend `feature-resolver.service.spec.ts` (it mocks the three repositories; add mocks for the two new ones following the same pattern): `getGlobalLimitOverrides` returns `{max_active_trips: null}` for a seeded launch-mode row, drops rows with negative/non-integer values; `resolveLimitsForUser` folds tier + user override + global (free user, override 5, global 2 → 2); `resolveEntitlementsForLoadedUser` returns both snapshots without a user query. Also update existing `resolveForLoadedUser` tests to the new name/shape.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement.** Inject the two new repositories; add (mirroring the existing style, including the defensive-drop stance):

```ts
export interface UserEntitlements {
  features: FeatureSnapshot;
  limits: LimitSnapshot;
}

/** Resolve every registry limit for one user (3 indexed reads). */
async resolveLimitsForUser(userId: string): Promise<LimitSnapshot> {
  const [user, overrides, globalOverrides] = await Promise.all([
    this.users.findOne({
      where: { id: userId },
      select: { id: true, subscription_tier: true },
    }),
    this.loadLimitOverrides(userId),
    this.getGlobalLimitOverrides(),
  ]);
  if (!user) throw new NotFoundException('User not found');
  return buildLimitSnapshot(user.subscription_tier, overrides, globalOverrides);
}

/**
 * Fetch-free combined variant for callers that already hold the user
 * row — `/users/me` and the auth responses resolve both snapshots with
 * four parallel indexed reads and no user query.
 */
async resolveEntitlementsForLoadedUser(
  user: Pick<User, 'id' | 'subscription_tier'>,
): Promise<UserEntitlements> {
  const [overrides, globalStates, limitOverrides, globalLimits] =
    await Promise.all([
      this.loadOverrides(user.id),
      this.getGlobalStates(),
      this.loadLimitOverrides(user.id),
      this.getGlobalLimitOverrides(),
    ]);
  return {
    features: buildFeatureSnapshot(user.subscription_tier, overrides, globalStates),
    limits: buildLimitSnapshot(user.subscription_tier, limitOverrides, globalLimits),
  };
}

/**
 * Global limit overrides currently in force. Rows with invalid values
 * (negative / non-integer) are dropped defensively — a bad row can
 * never widen an entitlement.
 */
async getGlobalLimitOverrides(): Promise<GlobalLimitOverrides> {
  const rows = await this.limitStates.find({
    select: { feature: true, value: true },
  });
  const overrides: Partial<Record<string, number | null>> = {};
  for (const row of rows) {
    if (isValidLimitValue(row.value)) overrides[row.feature] = row.value;
  }
  return overrides;
}

private async loadLimitOverrides(
  userId: string,
): Promise<Partial<Record<string, number | null>>> {
  const rows = await this.userLimits.find({
    where: { user_id: userId },
    select: { feature: true, value: true },
  });
  const overrides: Partial<Record<string, number | null>> = {};
  for (const row of rows) {
    if (isValidLimitValue(row.value)) overrides[row.feature] = row.value;
  }
  return overrides;
}
```

with a module-level `function isValidLimitValue(value: number | null): boolean { return value === null || (Number.isInteger(value) && value >= 0); }`. Delete `resolveForLoadedUser` (Task 5 migrates its callers in the next commit? NO — same-commit greenness rule: do Task 4 and Task 5 as ONE commit if deleting, or keep `resolveForLoadedUser` as a thin deprecated delegate until Task 5 removes it. **Do the latter**: keep `resolveForLoadedUser` delegating to `(await this.resolveEntitlementsForLoadedUser(user)).features` so this task commits green standalone; Task 5 deletes it.)

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns feature-resolver && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/features/
git commit -m "feat(backend): resolver limit layers (user + global) and combined entitlements"
```

---

### Task 5: Wire `limits` onto `/users/me` + auth responses

**Files:**

- Create: `apps/backend/src/modules/features/dto/limit-snapshot.dto.ts`
- Modify: `apps/backend/src/modules/users/dto/user-response.dto.ts`
- Modify: `apps/backend/src/modules/users/user-response.mapper.ts`
- Modify: `apps/backend/src/modules/users/users.service.ts` (3 call sites: ~lines 71, 557, 617)
- Modify: `apps/backend/src/modules/auth/auth.service.ts` (1 call site: ~line 201)
- Modify: `apps/backend/src/modules/features/feature-resolver.service.ts` (delete the deprecated `resolveForLoadedUser` delegate)
- Modify: `apps/backend/src/modules/features/feature-test-providers.ts`
- Modify: affected specs: `users/users.service.spec.ts`, `auth/*.spec.ts` files mocking `resolveForLoadedUser`, companion of `feature-resolver.service.spec.ts` if the delegate had a test.

**Interfaces:**

- Consumes: `UserEntitlements`, `resolveEntitlementsForLoadedUser` (Task 4); `LimitSnapshot`, `LIMIT_FEATURE_KEYS` (Tasks 1-2).
- Produces: `LimitSnapshotDto` (class, `implements LimitSnapshot`, shape-guarded); `UserResponseDto.limits!: LimitSnapshotDto`; `toUserResponse(user: User, entitlements: UserEntitlements): UserResponseDto` (signature change). Test helper: `buildUnlimitedLimitSnapshot(): LimitSnapshot` in `feature-test-providers.ts`.

- [ ] **Step 1: Write the failing test.** In `users.service.spec.ts`, update the resolver mock to `resolveEntitlementsForLoadedUser` returning `{ features: <existing all-on snapshot>, limits: { max_active_trips: null } }` and assert the `/me` response carries `limits: { max_active_trips: null }`. Mirror in the auth spec that asserts the login/register response user shape.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns 'users.service|auth'`
Expected: FAIL — `limits` missing from the response / mock method name mismatch.

- [ ] **Step 3: Implement.**
  - `limit-snapshot.dto.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";
import type { LimitSnapshot } from "@tarmoto/shared";

/**
 * Resolved numeric entitlements for the authenticated user — one value
 * per limit key in the `FEATURE_DEFINITIONS` registry; `null` =
 * unlimited. Rides along on `/users/me` and the auth responses beside
 * `features`. Server-side checks remain the authority.
 */
export class LimitSnapshotDto implements LimitSnapshot {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Maximum open (draft/planned/active) trips the user may own. null = unlimited.",
  })
  max_active_trips!: number | null;
}

// Compile-time shape guard — same contract as FeatureSnapshotDto's.
const _limitSnapshotShapeGuard: Record<
  keyof LimitSnapshot,
  true
> extends Record<keyof LimitSnapshotDto, true>
  ? true
  : never = true;
void _limitSnapshotShapeGuard;
```

- `user-response.dto.ts`: import `LimitSnapshotDto`; add below `features`:

```ts
@ApiProperty({
  type: LimitSnapshotDto,
  description:
    'Resolved numeric entitlements (null = unlimited), keyed by limit registry key.',
})
limits!: LimitSnapshotDto;
```

- `user-response.mapper.ts`: signature `toUserResponse(user: User, entitlements: UserEntitlements): UserResponseDto`; spread `features: entitlements.features, limits: entitlements.limits` into the return; update the doc comment sentence to name `resolveEntitlementsForLoadedUser`.
- All 4 call sites become `toUserResponse(x, await this.featureResolver.resolveEntitlementsForLoadedUser(x))`.
- Delete the `resolveForLoadedUser` delegate from the resolver.
- `feature-test-providers.ts`: add `export const buildUnlimitedLimitSnapshot = (): LimitSnapshot => Object.fromEntries(LIMIT_FEATURE_KEYS.map((key) => [key, null])) as LimitSnapshot;` and extend the resolver stub with `resolveEntitlementsForLoadedUser` / `resolveLimitsForUser` returning all-on features + unlimited limits (read the file — extend whatever stub shape it exports today).

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns 'users|auth|feature' && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/features/ apps/backend/src/modules/users/ apps/backend/src/modules/auth/
git commit -m "feat(backend): serve resolved limit snapshot on /users/me and auth responses"
```

---

### Task 6: `GET /api/v1/config/limits`

**Files:**

- Modify: `apps/backend/src/modules/client-config/client-config.controller.ts`
- Modify: `apps/backend/src/modules/client-config/client-config.service.ts`
- Modify: `apps/backend/src/modules/client-config/client-config.controller.spec.ts`, `client-config.service.spec.ts`

**Interfaces:**

- Consumes: `getGlobalLimitOverrides` (Task 4), `GlobalLimitOverrides` (Task 2).
- Produces: `GET /config/limits` (global prefix makes it `/api/v1/config/limits`) returning the flat `Record<string, number | null>` override map; `ClientConfigService.limitOverrides()`.

- [ ] **Step 1: Write the failing tests** — controller spec: `limits()` returns the service map and the route carries `Cache-Control: public, max-age=60` metadata (mirror how the existing `flags()` test asserts); service spec: `limitOverrides()` delegates to `featureResolver.getGlobalLimitOverrides()`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns client-config`
Expected: FAIL.

- [ ] **Step 3: Implement.** Service:

```ts
/**
 * Global limit overrides currently in force (`null` = unlimited).
 * Clients may apply a value from this map only as a downward clamp
 * (min with the authenticated snapshot) — never to raise one.
 */
limitOverrides(): Promise<GlobalLimitOverrides> {
  return this.featureResolver.getGlobalLimitOverrides();
}
```

Controller (below `flags()`):

```ts
@Get('limits')
@Header('Cache-Control', 'public, max-age=60')
@ApiOperation({
  summary: 'Global limit-override map (feature → value, null = unlimited)',
  description:
    'Only operator overrides appear here; a missing key means the ' +
    'limit resolves normally (registry tier value + per-user override, ' +
    'served on /users/me). Clients may apply these values only as a ' +
    'downward clamp (min with the cached snapshot) and must not raise ' +
    'a limit from this map.',
})
@ApiResponse({
  status: 200,
  schema: {
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
  },
})
limits(): Promise<GlobalLimitOverrides> {
  return this.service.limitOverrides();
}
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns client-config && pnpm backend:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/client-config/
git commit -m "feat(backend): public GET /config/limits global limit-override map"
```

---

### Task 7: Admin feature-limits endpoints

**Files:**

- Create: `apps/backend/src/modules/admin-flags/dto/admin-limits.dto.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-limits.service.ts`
- Create: `apps/backend/src/modules/admin-flags/admin-limits.controller.ts`
- Modify: `apps/backend/src/modules/admin-flags/admin-flags.module.ts` (register controller + service; add `UserLimit`, `LimitState` to `TypeOrmModule.forFeature`)
- Create: `apps/backend/src/modules/admin-flags/admin-limits.service.spec.ts`, `admin-limits.controller.spec.ts`, `dto/admin-limits.dto.spec.ts`

**Interfaces:**

- Consumes: `LIMIT_FEATURE_KEYS`, `isLimitFeatureKey`, `resolveLimit`, `FEATURE_DEFINITIONS`, `type LimitFeatureKey` (shared); `UserLimit`, `LimitState` entities; `AdminRoles`, `setAdminAuditTarget`, `AdminRequest` (existing admin plumbing — mirror `admin-flags.controller.ts`).
- Produces endpoints (used by Task 10/11 hooks):
  - `GET /admin/feature-limits` (support+) → `AdminFeatureLimitsResponseDto { limits: AdminFeatureLimitDto[] }`
  - `PUT /admin/feature-limits/:feature/global` (admin) body `SetLimitGlobalValueDto { value: number | null; reason: string }` → `AdminFeatureLimitDto`
  - `DELETE /admin/feature-limits/:feature/global` (admin, 204)
  - `GET /admin/users/:userId/feature-limits` (support+) → `AdminUserFeatureLimitsResponseDto { user_id, limits: AdminUserFeatureLimitDto[] }`
  - `PUT /admin/users/:userId/feature-limits/:feature` (admin) body `SetUserLimitOverrideDto { value: number | null }` → `AdminUserFeatureLimitsResponseDto`
  - `DELETE /admin/users/:userId/feature-limits/:feature` (admin, 204)

- [ ] **Step 1: Write the DTOs** (`admin-limits.dto.ts`):

```ts
import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

/** Admin wire shapes for numeric limit entitlements. The limit
 * vocabulary is code-defined (`FEATURE_DEFINITIONS`) — operators manage
 * only the two override layers. `null` = unlimited everywhere. */

export class TierLimitValuesDto {
  @ApiProperty({ type: Number, nullable: true }) free!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pro!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premium!: number | null;
}

export class AdminFeatureLimitDto {
  @ApiProperty({ description: "Registry limit key." })
  feature!: string;

  @ApiProperty() description!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Registry value for unknown tiers.",
  })
  default_value!: number | null;

  @ApiProperty({ type: TierLimitValuesDto })
  tier_values!: TierLimitValuesDto;

  @ApiProperty({ description: "Whether a global override row exists." })
  global_active!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Global override value (null = unlimited). Only meaningful when global_active.",
  })
  global_value!: number | null;

  @ApiProperty({ nullable: true }) global_reason!: string | null;
  @ApiProperty({ nullable: true }) global_updated_by!: string | null;
  @ApiProperty({ nullable: true }) global_updated_at!: string | null;

  @ApiProperty({ description: "Users with a per-user override." })
  overridden_user_count!: number;
}

export class AdminFeatureLimitsResponseDto {
  @ApiProperty({ type: [AdminFeatureLimitDto] })
  limits!: AdminFeatureLimitDto[];
}

export class SetLimitGlobalValueDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Override value; null = unlimited (launch mode / promo raise).",
  })
  @ValidateIf((o: SetLimitGlobalValueDto) => o.value !== null)
  @IsInt()
  @Min(0)
  value!: number | null;

  @ApiProperty({
    maxLength: 500,
    description:
      "Why the override is set — always required (any global limit change " +
      "is user-visible). Stored on the row, never audited.",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SetUserLimitOverrideDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Override value; null = unlimited.",
  })
  @ValidateIf((o: SetUserLimitOverrideDto) => o.value !== null)
  @IsInt()
  @Min(0)
  value!: number | null;
}

export class AdminUserFeatureLimitDto {
  @ApiProperty() feature!: string;
  @ApiProperty() description!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "The value the user actually resolves to right now (null = unlimited).",
  })
  resolved!: number | null;

  @ApiProperty({ description: "Whether a per-user override row exists." })
  override_active!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Override value (null = unlimited). Only meaningful when override_active.",
  })
  override_value!: number | null;
}

export class AdminUserFeatureLimitsResponseDto {
  @ApiProperty() user_id!: string;
  @ApiProperty({ type: [AdminUserFeatureLimitDto] })
  limits!: AdminUserFeatureLimitDto[];
}
```

- [ ] **Step 2: Write failing service/controller/dto specs.** Mirror the structure of `admin-flags.service.spec.ts` / `admin-flags.controller.spec.ts` / `dto/admin-flags.dto.spec.ts`:
  - service: `listLimits` merges registry + `limit_states` row + override counts; `setGlobalValue` upserts (value 3 / value null) and stamps `updated_by`; rejects unknown keys AND toggle keys (`gpx_export` → 400); `clearGlobalValue` idempotent delete; `getUserLimits` resolves via `resolveLimit` (free user + global null seed → resolved null, `override_active` false); `setOverride`/`removeOverride` upsert/delete + return refreshed `getUserLimits`; 404 unknown user.
  - dto spec (plainToInstance + validate): `SetLimitGlobalValueDto` accepts `{value: null, reason: "x"}` and `{value: 3, reason: "x"}`; rejects missing value, `value: -1`, `value: 1.5`, missing/blank reason. `SetUserLimitOverrideDto` accepts null/int, rejects missing/negative.
  - controller: role metadata (`support` reads, `admin` writes), audit target set (`feature_limit` for global mutations, `user` for per-user), delegates to service.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns admin-limits`
Expected: FAIL — files don't exist.

- [ ] **Step 4: Implement service** (`admin-limits.service.ts`) mirroring `AdminFlagsService` shape (no socket eviction — no limit gates sockets):

```ts
@Injectable()
export class AdminLimitsService {
  constructor(
    @InjectRepository(LimitState)
    private readonly limitStates: Repository<LimitState>,
    @InjectRepository(UserLimit)
    private readonly userLimits: Repository<UserLimit>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async listLimits(): Promise<AdminFeatureLimitsResponseDto> {
    const [states, counts] = await Promise.all([
      this.limitStates.find(),
      this.userLimits
        .createQueryBuilder("ul")
        .select("ul.feature", "feature")
        .addSelect("COUNT(*)", "count")
        .groupBy("ul.feature")
        .getRawMany<{ feature: string; count: string }>(),
    ]);
    const stateByFeature = new Map(states.map((s) => [s.feature, s]));
    const countByFeature = new Map(
      counts.map((c) => [c.feature, Number(c.count)]),
    );

    const limits = LIMIT_FEATURE_KEYS.map((feature): AdminFeatureLimitDto => {
      const def = FEATURE_DEFINITIONS[feature];
      const state = stateByFeature.get(feature);
      return {
        feature,
        description: def.description,
        default_value: def.default,
        tier_values: { ...def.tiers },
        global_active: state !== undefined,
        global_value: state?.value ?? null,
        global_reason: state?.reason ?? null,
        global_updated_by: state?.updated_by ?? null,
        global_updated_at: state ? state.updated_at.toISOString() : null,
        overridden_user_count: countByFeature.get(feature) ?? 0,
      };
    });
    return { limits };
  }

  async setGlobalValue(
    feature: string,
    dto: SetLimitGlobalValueDto,
    adminUserId: string,
  ): Promise<AdminFeatureLimitDto> {
    const key = this.assertKnownLimit(feature);
    const existing = await this.limitStates.findOne({
      where: { feature: key },
    });
    const row = existing ?? this.limitStates.create({ feature: key });
    row.value = dto.value;
    row.reason = dto.reason;
    row.updated_by = adminUserId;
    await this.limitStates.save(row);
    return this.limitDto(key);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async clearGlobalValue(feature: string): Promise<void> {
    const key = this.assertKnownLimit(feature);
    await this.limitStates.delete({ feature: key });
  }

  async getUserLimits(
    userId: string,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    const user = await this.findUser(userId);
    const [overrides, states] = await Promise.all([
      this.userLimits.find({ where: { user_id: user.id } }),
      this.limitStates.find(),
    ]);
    const overrideByFeature = new Map(
      overrides.map((o) => [o.feature, o.value]),
    );
    const stateByFeature = new Map(states.map((s) => [s.feature, s.value]));

    const limits = LIMIT_FEATURE_KEYS.map(
      (feature): AdminUserFeatureLimitDto => {
        const def = FEATURE_DEFINITIONS[feature];
        const hasOverride = overrideByFeature.has(feature);
        return {
          feature,
          description: def.description,
          resolved: resolveLimit(
            feature,
            user.subscription_tier,
            hasOverride ? overrideByFeature.get(feature) : undefined,
            stateByFeature.has(feature)
              ? stateByFeature.get(feature)
              : undefined,
          ),
          override_active: hasOverride,
          override_value: hasOverride
            ? (overrideByFeature.get(feature) ?? null)
            : null,
        };
      },
    );
    return { user_id: user.id, limits };
  }

  async setOverride(
    userId: string,
    feature: string,
    dto: SetUserLimitOverrideDto,
  ): Promise<AdminUserFeatureLimitsResponseDto> {
    const key = this.assertKnownLimit(feature);
    const user = await this.findUser(userId);
    const existing = await this.userLimits.findOne({
      where: { user_id: user.id, feature: key },
    });
    const row =
      existing ?? this.userLimits.create({ user_id: user.id, feature: key });
    row.value = dto.value;
    await this.userLimits.save(row);
    return this.getUserLimits(user.id);
  }

  /** Removing an absent override is a no-op — the call is idempotent. */
  async removeOverride(userId: string, feature: string): Promise<void> {
    const key = this.assertKnownLimit(feature);
    const user = await this.findUser(userId);
    await this.userLimits.delete({ user_id: user.id, feature: key });
  }

  private async limitDto(
    feature: LimitFeatureKey,
  ): Promise<AdminFeatureLimitDto> {
    const { limits } = await this.listLimits();
    const limit = limits.find((l) => l.feature === feature);
    if (!limit) throw new NotFoundException("Limit not found");
    return limit;
  }

  private assertKnownLimit(feature: string): LimitFeatureKey {
    if (!isLimitFeatureKey(feature)) {
      throw new BadRequestException(`Unknown limit: ${feature}`);
    }
    return feature;
  }

  private async findUser(userId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }
}
```

(Note the `hasOverride ? … : undefined` dance — `Map.get` returns `undefined` for both "absent" and "present with value null"; presence must be decided by `Map.has`, or a stored unlimited override would be dropped.)

- [ ] **Step 5: Implement controller** (`admin-limits.controller.ts`) — exact twin of `AdminFlagsController` with paths `feature-limits`, `@AdminRoles('support')` on the two GETs, `@AdminRoles('admin')` on mutations, `setAdminAuditTarget(req, { target_type: 'feature_limit', target_id: feature })` for global mutations and `{ target_type: 'user', target_id: userId }` for per-user ones, `@HttpCode(204)` on the DELETEs, `ParseUUIDPipe` on `userId`.

- [ ] **Step 6: Wire the module.** In `admin-flags.module.ts`: add `AdminLimitsController` to `controllers`, `AdminLimitsService` to `providers`, `UserLimit` + `LimitState` to the `TypeOrmModule.forFeature([...])` list.

- [ ] **Step 7: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns admin-limits && pnpm backend:build && pnpm backend:lint`
Expected: PASS (lint runs `--fix`; re-stage if it rewrites).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/admin-flags/
git commit -m "feat(backend): admin feature-limit endpoints (global + per-user overrides)"
```

---

### Task 8: Enforce `max_active_trips` in the trips service

**Files:**

- Create: `apps/backend/src/modules/features/feature-limit.error.ts`
- Modify: `apps/backend/src/modules/trips/trips.module.ts` (import `FeaturesModule`)
- Modify: `apps/backend/src/modules/trips/trips.service.ts` (inject `FeatureResolver`; guard 4 paths)
- Modify: `apps/backend/src/modules/trips/trips.service.spec.ts` (or the trips spec file that instantiates the service — add resolver stub + cap cases)

**Interfaces:**

- Consumes: `resolveLimitsForUser` (Task 4), `isWithinLimit` (Task 2).
- Produces: `featureLimitExceeded(feature: LimitFeatureKey, limit: number, current: number): ForbiddenException` and `FEATURE_LIMIT_EXCEEDED = 'FEATURE_LIMIT_EXCEEDED'` (exported const — clients will match `code`). 403 body: `{ statusCode: 403, error: 'Forbidden', message, code, feature, limit, current }`.

- [ ] **Step 1: Write the failing tests.** In the trips service spec, register a `FeatureResolver` stub provider whose `resolveLimitsForUser` defaults to `{ max_active_trips: null }` (**unlimited default keeps every existing trips test green**). Add cases:
  - create at cap: stub `{ max_active_trips: 1 }`, `tripRepo.count` → 1 → expect rejection with `ForbiddenException`, response body `code: 'FEATURE_LIMIT_EXCEEDED'`, `feature: 'max_active_trips'`, `limit: 1`, `current: 1`.
  - create under cap: count 0 → resolves; `count` was called with `{ owner_id, status: In(['draft','planned','active']) }`.
  - unlimited: stub null → `tripRepo.count` NOT called (launch mode adds zero queries).
  - duplicate + import: same at-cap rejection.
  - update reopen: locked trip status `completed`, `dto.status: 'planned'`, at cap → rejects; PATCH that keeps status `completed` or edits other fields does not invoke the check.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns trips.service`
Expected: FAIL — new cases (existing cases must still pass via the unlimited stub; if the suite fails on DI, add the stub provider first).

- [ ] **Step 3: Implement.** `feature-limit.error.ts`:

```ts
import { ForbiddenException } from "@nestjs/common";
import type { LimitFeatureKey } from "@tarmoto/shared";

/** Machine-readable code carried on limit-rejection 403 bodies. */
export const FEATURE_LIMIT_EXCEEDED = "FEATURE_LIMIT_EXCEEDED";

/**
 * 403 for "you are at your numeric entitlement cap". The body carries
 * the feature key + numbers so clients can render upgrade prompts
 * without string-matching the message.
 */
export function featureLimitExceeded(
  feature: LimitFeatureKey,
  limit: number,
  current: number,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: "Forbidden",
    message: `Feature limit exceeded: ${feature} (limit ${limit}, current ${current})`,
    code: FEATURE_LIMIT_EXCEEDED,
    feature,
    limit,
    current,
  });
}
```

`trips.service.ts` — near the existing top-of-file constants:

```ts
/** Trip statuses that count against `max_active_trips` (owner only). */
const OPEN_TRIP_STATUSES = ["draft", "planned", "active"] as const;
```

private method (place near the other private helpers):

```ts
/**
 * `max_active_trips` gate — counts open trips the OWNER holds and
 * rejects minting another at the cap. Check-then-act: two concurrent
 * creates can each pass the count and briefly overshoot by one; the
 * next mint re-checks, so the cap self-corrects. Accepted for v1 —
 * serialising every trip create on a per-user lock isn't worth that
 * failure mode.
 */
private async assertCanMintOpenTrip(ownerId: string): Promise<void> {
  const limits = await this.featureResolver.resolveLimitsForUser(ownerId);
  const limit = limits.max_active_trips;
  if (limit === null) return; // unlimited — skip the count entirely
  const current = await this.tripRepo.count({
    where: { owner_id: ownerId, status: In([...OPEN_TRIP_STATUSES]) },
  });
  if (!isWithinLimit(limit, current)) {
    throw featureLimitExceeded('max_active_trips', limit, current);
  }
}
```

Call sites:

- `create(userId, dto)`: `await this.assertCanMintOpenTrip(userId);` as the first statement.
- `importFromRoute(userId, dto)`: same, first statement.
- `duplicate(userId, tripId)`: after the source-trip load/authorization (404 semantics first), before building the copy.
- `update(...)`: inside the existing pessimistic-lock transaction, right after the `locked` null-check:

```ts
const reopening =
  dto.status !== undefined &&
  locked.status === "completed" &&
  dto.status !== "completed";
if (reopening) {
  await this.assertCanMintOpenTrip(locked.owner_id);
}
```

(the reopened trip is still `completed` in the count at this point, so `current` = the owner's _other_ open trips — correct). Note the owner's cap governs, not the caller's — an admin collaborator reopening affects the owner's slot budget.

Add `In` to the typeorm imports if absent; inject `private readonly featureResolver: FeatureResolver` in the constructor; add `FeaturesModule` to `trips.module.ts` imports.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/backend test -- --testPathPatterns trips && pnpm backend:build && pnpm backend:lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/features/feature-limit.error.ts apps/backend/src/modules/trips/
git commit -m "feat(backend): enforce max_active_trips on trip create/import/duplicate/reopen"
```

---

### Task 9: Contract regen + client fixture repair

**Files:**

- Regenerated: `packages/openapi/openapi.yaml` (+ Postman collection), `packages/openapi-client/src/generated/schema.d.ts`
- Modify: any mobile/companion/admin test fixtures and types that construct a full user response (they now need `limits`) — find them by running the typechecks below; known suspects: `apps/companion/src/app/(dashboard)/settings/profile/page.test.tsx`, `settings/subscription/page.test.tsx`, `apps/companion/src/lib/__tests__/subscription.test.ts`, mobile screen tests with `features: buildFeatureSnapshot(...)` fixtures (`AchievementsScreen`, `BadgesScreen`, `ChallengesScreen`, `LinkAccountScreen`, `CrashDetectionRunner`).

**Interfaces:**

- Consumes: all backend DTO changes (Tasks 5-7).
- Produces: regenerated types used by Task 10/11 (`components["schemas"]["AdminFeatureLimitDto"]` etc. become available to the admin app). Fixture idiom: `limits: buildLimitSnapshot("free", {}, {})` from `@tarmoto/shared` next to every existing `features: buildFeatureSnapshot(...)`.

- [ ] **Step 1: Regenerate**

Run: `pnpm openapi:gen && pnpm postman:gen && (cd packages/openapi-client && pnpm generate) && pnpm --filter @tarmoto/openapi test`
Expected: PASS; `git diff --stat` shows `openapi.yaml` + `schema.d.ts` gaining `LimitSnapshotDto`, `limits`, `/config/limits`, `/admin/feature-limits*`.

- [ ] **Step 2: Typecheck every consumer and repair fixtures**

Run: `pnpm --filter @tarmoto/admin typecheck && (cd apps/companion && npx tsc --noEmit) && (cd apps/mobile && npx tsc --noEmit)`
Expected: initial FAILs where fixtures construct user responses without `limits`. Add `limits: buildLimitSnapshot("free", {}, {})` (import from `@tarmoto/shared`) beside each `features: buildFeatureSnapshot(...)` until clean. Do NOT add client feature-gating — fixtures only.

- [ ] **Step 3: Run client test suites**

Run: `pnpm --filter @tarmoto/companion test && pnpm --filter @tarmoto/mobile test && pnpm admin:test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/openapi packages/openapi-client apps/companion apps/mobile
git commit -m "feat(openapi): regenerate contract with limit snapshot + admin limit endpoints"
```

---

### Task 10: Admin UI — Limits section on FeatureFlagsScreen

**Files:**

- Modify: `apps/admin/src/data/useAdminFlags.ts` (add limit hooks)
- Modify: `apps/admin/src/screens/FeatureFlagsScreen.tsx` (add `FeatureLimitsCard` below the flags table, above/beside `LaunchModeCard` — pick the slot that reads naturally in the existing layout)
- Modify: `apps/admin/src/screens/FeatureFlagsScreen.test.tsx`

**Interfaces:**

- Consumes: regenerated `components["schemas"]["AdminFeatureLimitDto"]` etc.; `@tarmoto/ui` (`DataTable`, `Pill`, `Button`, `Alert`, `Input`), local `Dialog`, existing `readErrorMessage` helper.
- Produces hooks (Task 11 reuses the per-user pair): `useAdminFeatureLimits()`, `useSetLimitGlobal()`, `useClearLimitGlobal()`, `useAdminUserFeatureLimits(userId: string | null)`, `useSetLimitOverride()`, `useRemoveLimitOverride()`.

- [ ] **Step 1: Add the hooks** (append to `useAdminFlags.ts`, exact same thin-wrapper idiom):

```ts
export function useAdminFeatureLimits() {
  return $api.useQuery("get", "/admin/feature-limits");
}

export function useSetLimitGlobal() {
  return $api.useMutation("put", "/admin/feature-limits/{feature}/global");
}

export function useClearLimitGlobal() {
  return $api.useMutation("delete", "/admin/feature-limits/{feature}/global");
}

export function useAdminUserFeatureLimits(userId: string | null) {
  return $api.useQuery(
    "get",
    "/admin/users/{userId}/feature-limits",
    { params: { path: { userId: userId ?? "" } } },
    { enabled: !!userId },
  );
}

export function useSetLimitOverride() {
  return $api.useMutation(
    "put",
    "/admin/users/{userId}/feature-limits/{feature}",
  );
}

export function useRemoveLimitOverride() {
  return $api.useMutation(
    "delete",
    "/admin/users/{userId}/feature-limits/{feature}",
  );
}
```

- [ ] **Step 2: Write failing screen tests.** Extend `FeatureFlagsScreen.test.tsx` following its existing mock pattern (it mocks `../data/useAdminFlags.js` — add the three new hooks to the mock): renders a "Limits" card with a `max_active_trips` row showing per-tier values (`1 / ∞ / ∞`) and the active global override (`∞` + reason for the launch-mode row); "Set global override" opens a dialog whose submit fires `useSetLimitGlobal().mutate` with `{ value: 3, reason }` (and `{ value: null }` when "Unlimited" is checked); "Clear" fires `useClearLimitGlobal().mutate`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @tarmoto/admin exec vitest run FeatureFlagsScreen`
(NOT `pnpm admin:test -- X` — the admin test script is compound and pnpm would append the filter to its trailing `node --test` command.)
Expected: FAIL.

- [ ] **Step 4: Implement `FeatureLimitsCard`** inside `FeatureFlagsScreen.tsx` (rendered from `FeatureFlagsScreen`; type rows as `components["schemas"]["AdminFeatureLimitDto"]`). Shape (follow the screen's existing state/mutation/dialog idioms — `pendingKey`, `readErrorMessage`, `Dialog` with a form):

```tsx
type FeatureLimit = components["schemas"]["AdminFeatureLimitDto"];

const formatLimit = (v: number | null | undefined) =>
  v === null ? "∞" : String(v);

function FeatureLimitsCard() {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Set-override dialog state (value OR unlimited + mandatory reason)
  const [target, setTarget] = useState<FeatureLimit | null>(null);
  const [valueInput, setValueInput] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const { data, isPending, error, refetch } = useAdminFeatureLimits();
  const setGlobalMutation = useSetLimitGlobal();
  const clearGlobalMutation = useClearLimitGlobal();
  const rows: FeatureLimit[] = data?.limits ?? [];

  function openDialog(row: FeatureLimit) {
    setTarget(row);
    setUnlimited(row.global_active && row.global_value === null);
    setValueInput(
      row.global_active && row.global_value !== null
        ? String(row.global_value)
        : "",
    );
    setReason("");
    setDialogError(null);
  }

  function handleSetSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setDialogError("A reason is required for any global limit change.");
      return;
    }
    const parsed = Number(valueInput);
    if (!unlimited && (!Number.isInteger(parsed) || parsed < 0)) {
      setDialogError("Value must be a non-negative integer (or Unlimited).");
      return;
    }
    setDialogError(null);
    setGlobalMutation.mutate(
      {
        params: { path: { feature: target.feature } },
        body: { value: unlimited ? null : parsed, reason: trimmedReason },
      },
      {
        onSuccess: () => {
          setTarget(null);
          void refetch();
        },
        onError: (err: unknown) =>
          setDialogError(
            readErrorMessage(err, "Failed to set the limit override."),
          ),
      },
    );
  }

  function clearGlobal(row: FeatureLimit) {
    setPendingKey(row.feature);
    setActionError(null);
    clearGlobalMutation.mutate(
      { params: { path: { feature: row.feature } } },
      {
        onSuccess: () => void refetch(),
        onError: (err: unknown) =>
          setActionError(
            readErrorMessage(err, "Failed to clear the limit override."),
          ),
        onSettled: () => setPendingKey(null),
      },
    );
  }

  const columns: ReadonlyArray<DataTableColumn<FeatureLimit>> = [
    {
      key: "feature",
      label: "Limit",
      primary: true,
      render: (row) => row.feature,
    },
    {
      key: "description",
      label: "Description",
      render: (row) => row.description,
    },
    {
      key: "tiers",
      label: "Free / Pro / Premium",
      size: "160px",
      render: (row) => (
        <span className="tabular-nums">
          {formatLimit(row.tier_values.free)} /{" "}
          {formatLimit(row.tier_values.pro)} /{" "}
          {formatLimit(row.tier_values.premium)}
        </span>
      ),
    },
    {
      key: "global",
      label: "Global override",
      size: "180px",
      render: (row) =>
        row.global_active ? (
          <Pill variant="warning">{formatLimit(row.global_value)}</Pill>
        ) : (
          <span className="text-fg-dim">—</span>
        ),
    },
    // actions column: "Set override" + (global_active ? "Clear" : null),
    // disabled while pendingKey === row.feature
  ];
  // render: <section> heading "Limits" + error Alerts + DataTable + Dialog form
}
```

Write the full component (~this shape, all handlers concrete) — the test from Step 2 defines the observable behavior. Keep the launch-mode row's reason visible (e.g. description line under the pill or a `title` attribute) so operators see WHY `∞` is forced.

- [ ] **Step 5: Verify green**

Run: `pnpm --filter @tarmoto/admin exec vitest run FeatureFlagsScreen && pnpm --filter @tarmoto/admin typecheck && pnpm --filter @tarmoto/admin lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/data/useAdminFlags.ts apps/admin/src/screens/FeatureFlagsScreen.tsx apps/admin/src/screens/FeatureFlagsScreen.test.tsx
git commit -m "feat(admin): feature limits card with global override management"
```

---

### Task 11: Admin UI — per-user limit overrides on UsersScreen

**Files:**

- Modify: `apps/admin/src/screens/UsersScreen.tsx` (add `UserFeatureLimitsCard` directly below `UserFeatureFlagsCard`)
- Modify: `apps/admin/src/screens/UsersScreen.test.tsx`

**Interfaces:**

- Consumes: `useAdminUserFeatureLimits`, `useSetLimitOverride`, `useRemoveLimitOverride` (Task 10); `components["schemas"]["AdminUserFeatureLimitDto"]`.
- Produces: nothing downstream.

- [ ] **Step 1: Write failing tests.** Extend `UsersScreen.test.tsx` (mock the three hooks like the flag-override hooks are mocked): the detail pane renders a "Feature limits" card with a `max_active_trips` row showing `resolved` (`∞` for null) and override state; setting a value fires `useSetLimitOverride().mutate` with `{ params: { path: { userId, feature: "max_active_trips" } }, body: { value: 5 } }`; "Unlimited" sends `{ value: null }`; "Remove" fires `useRemoveLimitOverride().mutate`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tarmoto/admin exec vitest run UsersScreen`
Expected: FAIL.

- [ ] **Step 3: Implement `UserFeatureLimitsCard({ userId })`** mirroring `UserFeatureFlagsCard`'s exact structure (pendingKey state, error Alert, refetch-on-success): per row show feature, description, `resolved` (∞/number, `tabular-nums`), and when `override_active` a Pill with the override value; actions = inline number input + "Set" button, "Unlimited" button, and "Remove override" when `override_active`. Client-side validate the number input (non-negative integer) before mutating. Core handlers:

```tsx
function setOverride(feature: string, value: number | null) {
  setPendingKey(feature);
  setLimitError(null);
  setOverrideMutation.mutate(
    { params: { path: { userId, feature } }, body: { value } },
    {
      onSuccess: () => void refetch(),
      onError: (err: unknown) => {
        const serverMsg = (err as { message?: string } | undefined)?.message;
        setLimitError(serverMsg ?? "Failed to set the limit override.");
      },
      onSettled: () => setPendingKey(null),
    },
  );
}

function removeOverride(feature: string) {
  setPendingKey(feature);
  removeOverrideMutation.mutate(
    { params: { path: { userId, feature } } },
    {
      onSuccess: () => void refetch(),
      onError: (err: unknown) => {
        const serverMsg = (err as { message?: string } | undefined)?.message;
        setLimitError(serverMsg ?? "Failed to remove the limit override.");
      },
      onSettled: () => setPendingKey(null),
    },
  );
}
```

("Set" parses the row's draft input and calls `setOverride(feature, parsed)`; "Unlimited" calls `setOverride(feature, null)`.)

- [ ] **Step 4: Verify green**

Run: `pnpm --filter @tarmoto/admin exec vitest run UsersScreen && pnpm --filter @tarmoto/admin typecheck && pnpm --filter @tarmoto/admin lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/screens/UsersScreen.tsx apps/admin/src/screens/UsersScreen.test.tsx
git commit -m "feat(admin): per-user feature limit overrides on the user detail pane"
```

---

### Task 12: Full-repo validation + spec conformance sweep

**Files:** none new — verification + fixes only.

- [ ] **Step 1: Full builds + suites**

Run (each must PASS):

```bash
pnpm shared:build && pnpm openapi:gen && pnpm postman:gen
pnpm backend:lint && pnpm backend:test && pnpm backend:build
pnpm admin:test && pnpm --filter @tarmoto/admin typecheck
pnpm --filter @tarmoto/companion test && (cd apps/companion && npx tsc --noEmit)
pnpm --filter @tarmoto/mobile test && (cd apps/mobile && npx tsc --noEmit)
pnpm --filter @tarmoto/shared test
```

- [ ] **Step 2: Spec conformance checklist** — re-read `docs/superpowers/specs/2026-07-17-numeric-feature-limits-design.md` §3.1-3.7 and confirm each clause maps to landed code; in particular: null=unlimited invariants, min-clamp precedence, launch-mode seed, additive-only wire (diff `openapi.yaml` — no existing field changed shape), reason required on global limit writes, 403 payload fields, reopen path owner semantics, no client feature-gating added.

- [ ] **Step 3: Diff review** — `git diff main...HEAD` sweep for debug leftovers, dead code, accidental formatting churn, missing `.js` import suffixes, unregistered entities/migrations.

- [ ] **Step 4: Fix anything found, amend/commit as needed, report** what was validated and anything that could not be run (e.g. no local Docker DB for the live migration).

---

## Execution notes

- Tasks 1→9 are strictly ordered (each consumes the previous). Tasks 10 and 11 both depend on 9 but not on each other.
- The trips spec resolver stub MUST default to unlimited (`{ max_active_trips: null }`) or unrelated existing trips tests will start failing.
- If `pnpm openapi:gen` fails with `noUncheckedIndexedAccess` errors that `nest build` missed, fix them at the source — that step is the strict-tsc oracle CI uses.
- After any main-merge/rebase during execution, run `pnpm shared:build` before trusting local eslint output (stale `@tarmoto/shared` dist produces phantom "type could not be resolved" noise).
