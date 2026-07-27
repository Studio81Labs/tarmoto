# Feature-Flag Enforcement SP1 — Backend Paid Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-enforce three paid entitlements that currently gate nothing — `advanced_ride_stats` (omit advanced ride fields), `max_group_ride_members` (join cap), `collaborative_trips` (toggle guard) — and ship them dark via a `force_on` seed so no current rider regresses.

**Architecture:** NestJS backend. Reuse the existing `FeatureResolver` (already injected in `RidesService`; inject into `GroupRidesService`), the shared pure `isFeatureEnabled`/`getFeatureLimit`, the `@RequireFeature`/`FeatureGuard` decorator, and the `FEATURE_LIMIT_EXCEEDED` error. One TypeORM migration seeds the launch overrides.

**Tech Stack:** NestJS 11, TypeORM, `@tarmoto/shared`, Jest (unit + e2e), OpenAPI gen.

## Global Constraints

- **Backend-only.** No client changes (that is SP2). Server enforcement must stand alone.
- **No OpenAPI contract break.** `advanced_ride_stats` gating nulls fields that are ALREADY `| null` in `RideResponseDto`; no field added/removed. Run `pnpm openapi:gen` and confirm a byte-identical (or description-only) diff.
- **Ships dark.** A migration seeds `feature_states force_on` for `advanced_ride_stats` + `collaborative_trips` (mirroring migration 1795). Enforcement code is live+tested but inert until an operator clears the seed at go-live.
- **Entitlement resolution:** toggles via `featureResolver.resolveForUser(userId)` → `FeatureSnapshot` → `isFeatureEnabled(snapshot, key)`; limits via `featureResolver.resolveLimitsForUser(userId)` → `getFeatureLimit(snapshot, key)`. Both from `@tarmoto/shared`.
- **`advanced_ride_stats` is governed by the REQUESTING user's entitlement**, not the ride owner's (a Free rider viewing a shared ride sees basic-only).
- Conventional commits, scope `backend`, end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit header ≤ 100 chars (commitlint).

---

### Task 1: `advanced_ride_stats` — strip advanced fields for non-entitled riders

**Files:**

- Create: `apps/backend/src/modules/rides/advanced-ride-stats.ts` (pure helper)
- Test: `apps/backend/src/modules/rides/advanced-ride-stats.spec.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts` (`list`, `getDetail`)

**Interfaces:**

- Produces: `stripAdvancedRideStats<T extends RideResponseDto>(dto: T): T` — returns a shallow copy with the advanced fields nulled. Advanced fields: `max_lean_angle`, `lean_distribution`, `elevation_gain`, `elevation_loss`, and each `segments[i].lean_angle_max`. Everything else untouched.
- Consumes: `FeatureResolver.resolveForUser`, `isFeatureEnabled` (`@tarmoto/shared`).

- [ ] **Step 1: Write the failing unit test** — `advanced-ride-stats.spec.ts`:

```ts
import { stripAdvancedRideStats } from "./advanced-ride-stats.js";

const full = {
  id: "r1",
  distance_km: 42.5,
  avg_speed: 45,
  avg_road_quality: 4,
  max_lean_angle: 38,
  lean_distribution: { lt10: 1, from10to20: 2, from20to30: 3, gte30: 4 },
  elevation_gain: 320,
  elevation_loss: 280,
  segments: [
    {
      road_segment_id: "s1",
      quality_reading: 4,
      speed_avg: 40,
      speed_max: 60,
      lean_angle_max: 30,
    },
  ],
} as never;

it("nulls advanced fields but keeps basic ones", () => {
  const stripped = stripAdvancedRideStats(full) as Record<string, unknown> & {
    segments: Array<Record<string, unknown>>;
  };
  expect(stripped.max_lean_angle).toBeNull();
  expect(stripped.lean_distribution).toBeNull();
  expect(stripped.elevation_gain).toBeNull();
  expect(stripped.elevation_loss).toBeNull();
  expect(stripped.segments[0].lean_angle_max).toBeNull();
  // basic fields intact
  expect(stripped.distance_km).toBe(42.5);
  expect(stripped.avg_speed).toBe(45);
  expect(stripped.avg_road_quality).toBe(4);
  expect(stripped.segments[0].quality_reading).toBe(4);
  expect(stripped.segments[0].speed_max).toBe(60);
});

it("does not mutate the input", () => {
  const before = full.max_lean_angle;
  stripAdvancedRideStats(full);
  expect(full.max_lean_angle).toBe(before);
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm --filter @tarmoto/backend test -- advanced-ride-stats` → FAIL (module not found).

- [ ] **Step 3: Implement the pure helper** — `advanced-ride-stats.ts`:

```ts
import type { RideResponseDto } from "./dto/ride-response.dto.js";

/**
 * `advanced_ride_stats` (Pro) paywall. Returns a copy of a ride response with
 * the ADVANCED stat fields nulled — lean angles (max + distribution + per
 * segment) and the elevation profile — while leaving the basic stats (distance,
 * speed, quality, curviness, duration, fuel, geometry) intact. Applied to the
 * list + detail read paths for a viewer who lacks the entitlement. Non-mutating.
 */
export function stripAdvancedRideStats<T extends RideResponseDto>(dto: T): T {
  return {
    ...dto,
    max_lean_angle: null,
    lean_distribution: null,
    elevation_gain: null,
    elevation_loss: null,
    segments: dto.segments.map((s) => ({ ...s, lean_angle_max: null })),
  };
}
```

- [ ] **Step 4: Run the unit test — PASS.**

- [ ] **Step 5: Wire into `getDetail` + `list`** in `rides.service.ts`. In `getDetail(userId, rideId)`, after building the `RideDetailDto`, resolve and strip:

```ts
// after the detail dto is assembled (call it `detail`):
const features = await this.featureResolver.resolveForUser(userId);
if (!isFeatureEnabled(features, "advanced_ride_stats")) {
  return stripAdvancedRideStats(detail);
}
return detail;
```

In `list(userId, query)`, resolve ONCE, then map:

```ts
const features = await this.featureResolver.resolveForUser(userId);
const gated = !isFeatureEnabled(features, "advanced_ride_stats");
const summaries = rides.map((r) => {
  const s = this.toSummary(r);
  return gated ? stripAdvancedRideStats(s) : s;
});
// ...use `summaries` in the returned page
```

Add imports: `stripAdvancedRideStats` from `./advanced-ride-stats.js`; `isFeatureEnabled` from `@tarmoto/shared`. (`featureResolver` is already injected.)

- [ ] **Step 6: Write/adjust the service e2e or integration test** — in the existing rides service/e2e spec, add: an entitled viewer's `getDetail` keeps `max_lean_angle`/`elevation_gain`; a non-entitled viewer's `getDetail` and `list` return them `null` with basic fields intact. Mock `featureResolver.resolveForUser` to return a snapshot with `advanced_ride_stats: true|false`.

- [ ] **Step 7: Run rides tests — PASS.** `pnpm --filter @tarmoto/backend test -- rides`

- [ ] **Step 8: Commit** — `feat(backend): gate advanced_ride_stats fields on the ride read paths`

---

### Task 2: `max_group_ride_members` — enforce the join cap

**Files:**

- Modify: `apps/backend/src/modules/group-rides/group-rides.service.ts` (`join`, constructor)
- Modify: `apps/backend/src/modules/group-rides/group-rides.module.ts` (ensure `FeaturesModule`/`FeatureResolver` is available)
- Test: `apps/backend/src/modules/group-rides/group-rides.service.spec.ts`

**Interfaces:**

- Consumes: `FeatureResolver.resolveLimitsForUser`, `getFeatureLimit` (`@tarmoto/shared`), `FEATURE_LIMIT_EXCEEDED` error (`../features/feature-limit.error.js`).

- [ ] **Step 1: Write the failing test** — a new member joining a ride already at the resolved cap throws the `FEATURE_LIMIT_EXCEEDED` 403; under cap joins; an existing member re-joining is a no-op (not counted); a `null` (unlimited) limit never blocks. Mock the resolver.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** Inject `FeatureResolver` into `GroupRidesService`. In `join`, when `!existing` (a genuinely new member), before the member `save`, count current members and enforce the cap **race-safely**: wrap the count + insert in a transaction that first takes the per-ride advisory lock (mirror `tripCollaboratorLockKey` — use a `group-ride:members:<rideId>` key via `SELECT pg_advisory_xact_lock(hashtext($1))`), then:

```ts
const limit = getFeatureLimit(
  await this.featureResolver.resolveLimitsForUser(userId),
  "max_group_ride_members",
);
// null = unlimited → skip. Finite N → block at/over N.
if (typeof limit === "number") {
  const count = await manager.count(GroupRideMember, {
    where: { group_ride_id: ride.id },
  });
  if (count >= limit) {
    throw new FeatureLimitExceededError("max_group_ride_members"); // 403, code FEATURE_LIMIT_EXCEEDED
  }
}
```

Use the actual error constructor/shape from `feature-limit.error.ts` (match how `TripsService` throws it). Resolve the limit OUTSIDE the transaction if the resolver hits the DB pool (pool-deadlock avoidance — mirror `resolveCollaboratorLimit`); pass the resolved value in.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `feat(backend): enforce max_group_ride_members on group-ride join`

---

### Task 3: `collaborative_trips` — toggle guard on the collaboration-create endpoints

**Files:**

- Modify: `apps/backend/src/modules/trips/trips.controller.ts` (`@Post(':tripId/invite')`)
- Modify: `apps/backend/src/modules/trip-shares/trip-shares.controller.ts` (`@Post()` create-share)
- Test: extend the trips / trip-shares e2e specs

**Interfaces:** Consumes `@RequireFeature('collaborative_trips')` + `FeatureGuard` (already used elsewhere, e.g. gpx/commute).

- [ ] **Step 1: Write the failing test** — with `collaborative_trips` resolved OFF, `POST /trips/:id/invite` and `POST /trip-shares` return 403 (feature-guard body, no `code`); with it ON, they proceed; `POST /trips` (create) is unaffected. Confirm the guard-mocking pattern used by the existing `gpx_export`/`commuter_mode` guard tests and reuse it.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** Add `@RequireFeature('collaborative_trips')` (+ `@UseGuards(FeatureGuard)` if not applied controller-wide) to:
  - `TripsController` `@Post(':tripId/invite')` (owner emails an invite)
  - `TripSharesController` `@Post()` (create share link)

  Do NOT gate `@Post(':tripId/join')` (an invitee accepting — already bounded by the owner's `max_trip_collaborators`), nor `@Post()` / `@Post('import')` trip creation (that's the free `trip_planning` flag). Match the exact guard-application idiom the codebase already uses for `@RequireFeature` (guard order: AuthGuard before FeatureGuard).

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `feat(backend): guard trip collaboration surface on collaborative_trips`

---

### Task 4: Migration — seed the dark-launch `force_on` overrides

**Files:**

- Create: `apps/backend/src/migrations/<timestamp>-SeedLaunchModeAdvancedStatsAndCollabTrips.ts`

**Interfaces:** none (DB only). Follow the migration dual-registration convention if this repo lists migrations in a data-source/module array — check `database.module.ts` / `data-source.ts` and register there too.

- [ ] **Step 1: Write the migration.** Mirror migration 1795's seed block. Use a timestamp AFTER the latest existing migration (check `ls src/migrations | sort | tail -3` and pick a strictly greater value):

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    INSERT INTO feature_states (feature, state, reason)
    VALUES
      ('advanced_ride_stats', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.'),
      ('collaborative_trips', 'force_on', 'Launch mode: keep pre-entitlement access open until tier enforcement goes live.')
    ON CONFLICT DO NOTHING;
  `);
}
public async down(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    DELETE FROM feature_states
    WHERE feature IN ('advanced_ride_stats', 'collaborative_trips') AND state = 'force_on';
  `);
}
```

Match the exact `feature_states` column names + the unique-constraint name used in 1795/1818 (`ON CONFLICT` target). If those migrations name the conflict target explicitly, do the same.

- [ ] **Step 2: Register the migration** wherever the repo enumerates them (dual-registration gotcha — grep for how `1818...` is referenced).

- [ ] **Step 3: Run the migration against the dev DB** (`pnpm db:migrate`) and confirm it applies + the two rows exist; run `down` then `up` to confirm reversibility.

- [ ] **Step 4: Commit** — `feat(backend): seed launch-mode force_on for advanced_ride_stats + collaborative_trips`

---

### Task 5: Docs + OpenAPI reconciliation

**Files:**

- Modify: `docs/feature-flags.md` (§ status note + §6.2)

- [ ] **Step 1: Update `docs/feature-flags.md`.** Move the enforced-entitlement count from 6 → 9 in the status note and §6.2; add `advanced_ride_stats`, `max_group_ride_members`, `collaborative_trips` to the enforced list with their enforcement site (ride read-path field strip / group-ride join limit / trips-collaboration `@RequireFeature`). Move the seeded-dark count 7 → 9 (add `advanced_ride_stats` + `collaborative_trips` to the seed list); note `max_group_ride_members` enforced-but-inert (premium unlimited). Remove those three from the "unenforced / remaining" lists.

- [ ] **Step 2: Regenerate OpenAPI + confirm no breaking change.** `pnpm openapi:gen`; `git diff` the generated spec — expect no field add/remove (advanced fields were already nullable). If the diff is non-trivial, stop and reconcile.

- [ ] **Step 3: Run the full backend suite + lint + build.** `pnpm --filter @tarmoto/backend test`, `pnpm --filter @tarmoto/backend lint`, `pnpm backend:build`.

- [ ] **Step 4: Commit** — `docs(backend): record SP1 enforcement in the feature-flag catalog`

---

## Self-review notes

- Every gated field in Task 1 is already `| null` in the DTO → no contract break. ✓
- `max_group_ride_members` is inert today (premium=null) but the seam + race-safety are correct for a future finite tier. ✓
- `collaborative_trips` gates only the owner's collaboration-CREATE surface; the invitee accept path and trip creation stay open. ✓
- The migration ships all three dark (the two toggles via `force_on`; the limit is inert), so no current rider regresses. ✓
