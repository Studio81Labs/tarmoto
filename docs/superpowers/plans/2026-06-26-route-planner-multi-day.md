# Route Planner Phase 2 — Manual Multi-Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the merged Phase 1 single-day manual route planner to N days, with chained-but-overridable live overnight links, an all-days color-coded map, per-day live routing, and a multi-day save.

**Architecture:** Reuse Phase 1's per-day `TripDay` storage end-to-end. The companion store gains a store-tracked `selectedDayIndex`, per-day staleness (`stalePreviewDays`), day lifecycle actions, and a central linked-start sync. The backend `PUT /trips/:id/route` generalizes from one day to a `days[]` array, re-routing + enriching each day in one transaction, and persists a new `start_linked` column.

**Tech Stack:** NestJS 11 + TypeORM + PostGIS (backend), Next.js + Zustand + MapLibre GL (companion), Valhalla/OSRM routing provider, Vitest (companion), Jest (backend), Playwright (e2e), generated OpenAPI client.

**Design spec:** `docs/superpowers/specs/2026-06-26-route-planner-multi-day-design.md`

## Global Constraints

- **Out of scope:** multi-day auto-generation, curvy/motorcycle profile, multi-day suggestion scoping, collaborative co-editing. Manual only.
- **Caps:** max **14** days per trip; max **50** waypoints per day (`MAX_ROUTE_WAYPOINTS`, already defined in `apps/backend/src/modules/routing/dto/route.dto.ts`). Both enforced client- and server-side.
- **Never trust client geometry:** the backend always re-routes each day from its waypoints via the routing provider.
- **Per-day validation (server):** each day requires exactly one `start` and one `end`, ordered first→last as `start … end`; WGS-84 coordinate bounds (inherited from `LatLngDto`).
- **`start_linked` semantics:** for day N≥2, `true` means the day's start mirrors day N-1's end. Day 1 is always `false`.
- **Metric units only** on the backend (km, minutes, meters) — unchanged from Phase 1.
- **Conventional commits**, scope one of: `backend`, `companion`, `cross`, `openapi`, `docs`. Subject lowercase.
- **Backend ESM imports** use `.js` extensions. **Companion** uses `@/` path alias.

## Canonical shapes (used across tasks)

**Companion `TripDay`** (in `apps/companion/src/lib/types.ts`) gains:

```ts
startLinked?: boolean; // day N≥2: start mirrors prev day's end. Day 1: always false/undefined.
```

**Store new/changed `TripState` members** (in `apps/companion/src/stores/trip.ts`):

```ts
selectedDayIndex: number;                       // was page-local; now store-tracked
stalePreviewDays: number[];                     // REPLACES `routePreviewStale: boolean`. dayNumbers whose geometry is stale.
setSelectedDay: (index: number) => void;
addDay: () => void;                             // appends a linked day, seeded from prev day's end
removeDay: (index: number) => void;             // min 1 day; re-evaluates adjacent boundary
relinkDayStart: (index: number) => void;        // sets startLinked=true, re-seeds start from prev end
```

Helpers:

```ts
function isDayStale(state, dayNumber): boolean; // stalePreviewDays.includes(dayNumber)
function dayCompleteness(day): "empty" | "incomplete" | "complete";
```

**Backend save contract** (`apps/backend/src/modules/trips/dto/save-route.dto.ts`):

```ts
class SaveRouteDayDto {
  dayNumber: number;
  startLinked: boolean;
  waypoints: SaveRouteWaypointDto[];
}
class SaveRouteDto {
  days: SaveRouteDayDto[];
  options?: RouteOptionsDto;
}
```

---

## Task 1: Backend — `start_linked` column, entity, migration

**Files:**

- Modify: `apps/backend/src/entities/trip-day.entity.ts`
- Create: `apps/backend/src/migrations/1718200000000-AddTripDayStartLinked.ts`
- Test: `apps/backend/src/migrations/1718200000000-AddTripDayStartLinked.spec.ts` (migration SQL shape assertion)

**Interfaces:**

- Produces: `TripDay.start_linked: boolean` (entity column, default `false`).

- [ ] **Step 1: Add the column to the entity**

In `trip-day.entity.ts`, after the `scenic_score` column block, add:

```ts
  @Column({ type: 'boolean', default: false })
  start_linked!: boolean;
```

- [ ] **Step 2: Write the migration**

Create `1718200000000-AddTripDayStartLinked.ts` (mirror the structure of `1718100000000-AddCommunityEngagement.ts`):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTripDayStartLinked1718200000000 implements MigrationInterface {
  name = "AddTripDayStartLinked1718200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE trip_days ADD COLUMN IF NOT EXISTS start_linked boolean NOT NULL DEFAULT false;",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE trip_days DROP COLUMN IF EXISTS start_linked;",
    );
  }
}
```

- [ ] **Step 3: Register the migration in the DataSource list if migrations are explicitly listed**

Check `apps/backend/src/database.module.ts` and `apps/backend/src/data-source.ts` (per memory: the runtime migration list lives in `database.module.ts`, and `data-source.ts`'s list is incomplete). Add `AddTripDayStartLinked1718200000000` to whichever array enumerates migrations explicitly. If migrations are glob-loaded, no change needed — verify by grepping for `AddCommunityEngagement` in both files and mirroring exactly.

- [ ] **Step 4: Write a migration shape test**

```ts
import { AddTripDayStartLinked1718200000000 } from "./1718200000000-AddTripDayStartLinked.js";

describe("AddTripDayStartLinked migration", () => {
  it("adds and drops the start_linked column", async () => {
    const queries: string[] = [];
    const qr = {
      query: async (q: string) => {
        queries.push(q);
      },
    } as never;
    const m = new AddTripDayStartLinked1718200000000();
    await m.up(qr);
    await m.down(qr);
    expect(queries[0]).toMatch(
      /ALTER TABLE trip_days ADD COLUMN IF NOT EXISTS start_linked boolean NOT NULL DEFAULT false/,
    );
    expect(queries[1]).toMatch(/DROP COLUMN IF EXISTS start_linked/);
  });
});
```

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @tarmoto/backend exec jest AddTripDayStartLinked` → PASS.
Run: `pnpm --filter @tarmoto/backend build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/trip-day.entity.ts apps/backend/src/migrations/1718200000000-AddTripDayStartLinked.ts apps/backend/src/migrations/1718200000000-AddTripDayStartLinked.spec.ts apps/backend/src/database.module.ts apps/backend/src/data-source.ts
git commit -m "feat(backend): add start_linked column to trip_days"
```

---

## Task 2: Backend — `TripDayDto.start_linked` in detail response

**Files:**

- Modify: `apps/backend/src/modules/trips/dto/trip-response.dto.ts` (`TripDayDto`)
- Modify: `apps/backend/src/modules/trips/trips.service.ts` (`toDetail` day mapping, ~lines 1386–1437)
- Test: `apps/backend/src/modules/trips/trips.service.spec.ts` (detail-mapping describe block)

**Interfaces:**

- Consumes: `TripDay.start_linked` (Task 1).
- Produces: `TripDayDto.start_linked: boolean` on the wire; companion reads it as `startLinked`.

- [ ] **Step 1: Add the DTO field**

In `TripDayDto`, after `estimated_time_min`, add:

```ts
  @ApiProperty()
  start_linked!: boolean;
```

- [ ] **Step 2: Map it in `toDetail`**

In the `days` map of `toDetail`, add to each day object:

```ts
    start_linked: d.start_linked ?? false,
```

- [ ] **Step 3: Write a failing test**

Add to the detail-mapping describe in `trips.service.spec.ts`:

```ts
it("maps start_linked from the day entity (defaulting false)", async () => {
  const trip = makeOwnedTrip({
    days: [
      {
        id: "d-1",
        day_number: 1,
        /* …existing minimal fields… */ start_linked: false,
        waypoints: [],
      },
      { id: "d-2", day_number: 2, start_linked: true, waypoints: [] },
    ],
  });
  // arrange the repo mock to return `trip` from getDetail's query (mirror existing detail tests)
  const detail = await service.getDetail(OWNER_ID, TRIP_ID);
  expect(detail.days[0].start_linked).toBe(false);
  expect(detail.days[1].start_linked).toBe(true);
});
```

(Use the exact `makeOwnedTrip` helper + repo-mock pattern already in this spec's detail-mapping block.)

- [ ] **Step 4: Run the test** → PASS. Run `pnpm --filter @tarmoto/backend exec jest trips.service` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/modules/trips/dto/trip-response.dto.ts apps/backend/src/modules/trips/trips.service.ts apps/backend/src/modules/trips/trips.service.spec.ts
git commit -m "feat(backend): surface start_linked on trip detail days"
```

---

## Task 3: Backend — multi-day `SaveRouteDto`

**Files:**

- Modify: `apps/backend/src/modules/trips/dto/save-route.dto.ts`
- Create: `apps/backend/src/modules/trips/dto/save-route.dto.spec.ts`

**Interfaces:**

- Consumes: `LatLngDto`, `MAX_ROUTE_WAYPOINTS`, `RouteOptionsDto` (from `routing/dto/route.dto.js`).
- Produces: `SaveRouteDayDto { dayNumber: number; startLinked: boolean; waypoints: SaveRouteWaypointDto[] }`, `SaveRouteDto { days: SaveRouteDayDto[]; options?: RouteOptionsDto }`, and `MAX_TRIP_DAYS = 14` exported from this file.

- [ ] **Step 1: Restructure the DTO**

Replace `SaveRouteDto` (keep `SaveRouteWaypointDto` and `SAVE_ROUTE_WAYPOINT_TYPES` as-is) with:

```ts
export const MAX_TRIP_DAYS = 14;

export class SaveRouteDayDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  dayNumber!: number;

  @ApiProperty()
  @IsBoolean()
  startLinked!: boolean;

  @ApiProperty({
    type: [SaveRouteWaypointDto],
    minItems: 2,
    maxItems: MAX_ROUTE_WAYPOINTS,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_ROUTE_WAYPOINTS)
  @ValidateNested({ each: true })
  @Type(() => SaveRouteWaypointDto)
  waypoints!: SaveRouteWaypointDto[];
}

export class SaveRouteDto {
  @ApiProperty({
    type: [SaveRouteDayDto],
    minItems: 1,
    maxItems: MAX_TRIP_DAYS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRIP_DAYS)
  @ValidateNested({ each: true })
  @Type(() => SaveRouteDayDto)
  days!: SaveRouteDayDto[];

  @ApiProperty({ required: false, type: RouteOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RouteOptionsDto)
  options?: RouteOptionsDto;
}
```

Add `IsBoolean`, `IsInt`, `Min` to the `class-validator` import.

- [ ] **Step 2: Write validation tests**

`save-route.dto.spec.ts` — use `class-validator`'s `validate` + `class-transformer`'s `plainToInstance`:

```ts
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SaveRouteDto, MAX_TRIP_DAYS } from "./save-route.dto.js";

const day = (dayNumber: number) => ({
  dayNumber,
  startLinked: dayNumber > 1,
  waypoints: [
    { lat: 50, lng: 14, type: "start" },
    { lat: 51, lng: 15, type: "end" },
  ],
});

async function errorsFor(payload: unknown) {
  return validate(plainToInstance(SaveRouteDto, payload));
}

it("accepts a single-day payload", async () => {
  expect(await errorsFor({ days: [day(1)] })).toHaveLength(0);
});
it("accepts a multi-day payload", async () => {
  expect(await errorsFor({ days: [day(1), day(2)] })).toHaveLength(0);
});
it("rejects an empty days array", async () => {
  expect((await errorsFor({ days: [] })).length).toBeGreaterThan(0);
});
it("rejects more than MAX_TRIP_DAYS days", async () => {
  const days = Array.from({ length: MAX_TRIP_DAYS + 1 }, (_, i) => day(i + 1));
  expect((await errorsFor({ days })).length).toBeGreaterThan(0);
});
it("rejects a day with <2 waypoints", async () => {
  expect(
    (
      await errorsFor({
        days: [
          {
            dayNumber: 1,
            startLinked: false,
            waypoints: [{ lat: 0, lng: 0, type: "start" }],
          },
        ],
      })
    ).length,
  ).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run** `pnpm --filter @tarmoto/backend exec jest save-route.dto` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/modules/trips/dto/save-route.dto.ts apps/backend/src/modules/trips/dto/save-route.dto.spec.ts
git commit -m "feat(backend): multi-day save-route DTO with per-day validation"
```

---

## Task 4: Backend — `saveManualRoute` saves all days

**Files:**

- Modify: `apps/backend/src/modules/trips/trips.service.ts` (`saveManualRoute`, ~lines 998–1149)
- Modify: `apps/backend/src/modules/trips/trips.service.spec.ts` (saveManualRoute describe)

**Interfaces:**

- Consumes: `SaveRouteDto { days, options }` (Task 3), `TripDay.start_linked` (Task 1).
- Produces: persists every day (re-routed + enriched + `start_linked`), renumbered 1..M; returns `TripDetailDto`.

- [ ] **Step 1: Extract a per-day route+enrich helper**

Above `saveManualRoute`, add a private method that validates ordering, routes, and enriches ONE day, returning the row fields (throws `BadRequestException`/`BadGatewayException` as Phase 1 did):

```ts
private async buildDayRoute(
  day: SaveRouteDayDto,
  options: SaveRouteDto['options'],
): Promise<{
  distance_km: number; estimated_time: string;
  avg_quality: number | null; curviness_score: number | null;
  scenic_score: number | null; elevation_gain: number; elevation_loss: number;
  route_geom: { type: 'LineString'; coordinates: number[][] };
}> {
  const startCount = day.waypoints.filter((w) => w.type === 'start').length;
  const endCount = day.waypoints.filter((w) => w.type === 'end').length;
  if (startCount !== 1 || endCount !== 1) {
    throw new BadRequestException(
      `Day ${day.dayNumber} must have exactly one start and one end waypoint`,
    );
  }
  const routing = day.waypoints.filter((w) => ['start', 'via', 'end'].includes(w.type));
  if (routing[0]?.type !== 'start' || routing[routing.length - 1]?.type !== 'end') {
    throw new BadRequestException(
      `Day ${day.dayNumber} waypoints must be ordered from start to end`,
    );
  }
  const route = await this.routingProvider.route(
    routing.map((w) => ({ lat: w.lat, lng: w.lng })),
    { avoidHighways: options?.avoid_highways, avoidTolls: options?.avoid_tolls },
  );
  if (!route) {
    throw new BadGatewayException(`No road route for day ${day.dayNumber}`);
  }
  const m = await this.enrichment.aggregate(route.geometry);
  return {
    distance_km: Number(route.distance_km.toFixed(2)),
    estimated_time: `${Math.round(route.duration_min)} minutes`,
    avg_quality: m.avgQuality, curviness_score: m.curvinessScore,
    scenic_score: m.scenicScore, elevation_gain: Math.round(m.elevationGain),
    elevation_loss: Math.round(m.elevationLoss),
    route_geom: { type: 'LineString', coordinates: route.geometry.map((p) => [p.lng, p.lat]) },
  };
}
```

- [ ] **Step 2: Rewrite `saveManualRoute` to iterate days**

Replace the body (keep the membership gate). Route every day BEFORE the transaction (so a 502 aborts cleanly without partial writes), then replace all days transactionally:

```ts
async saveManualRoute(userId: string, tripId: string, dto: SaveRouteDto): Promise<TripDetailDto> {
  const member = await this.memberRepo.findOne({ where: { trip_id: tripId, user_id: userId } });
  if (!member) throw new NotFoundException('Trip not found');

  // Renumber contiguously (defensive — client already drops empties).
  const days = dto.days.map((d, i) => ({ ...d, dayNumber: i + 1 }));
  // Route + enrich each day up front (throws abort the whole save, no partial writes).
  const built = await Promise.all(days.map((d) => this.buildDayRoute(d, dto.options)));

  await this.tripRepo.manager.transaction(async (manager) => {
    const locked = await manager.findOne(Trip, { where: { id: tripId }, lock: { mode: 'pessimistic_write' } });
    if (!locked) throw new NotFoundException('Trip not found');

    // Decouple ALL suggestions on this trip's days before deleting (mirror Phase 1's day-1 unscoping, now all days).
    const existingDays = await manager.find(TripDay, { where: { trip_id: tripId } });
    if (existingDays.length > 0) {
      await manager.update(
        TripSuggestion,
        { trip_day_id: In(existingDays.map((d) => d.id)) },
        { trip_day_id: null },
      );
      await manager.delete(TripDay, { trip_id: tripId });
    }

    for (let i = 0; i < days.length; i++) {
      const d = days[i]; const b = built[i];
      const dayRow = await manager.save(manager.create(TripDay, {
        trip_id: tripId, day_number: d.dayNumber, start_linked: d.startLinked,
        distance_km: b.distance_km, estimated_time: b.estimated_time,
        avg_quality: b.avg_quality, curviness_score: b.curviness_score,
        scenic_score: b.scenic_score, elevation_gain: b.elevation_gain,
        elevation_loss: b.elevation_loss, route_geom: b.route_geom,
      }));
      const waypointRows = d.waypoints.map((w, idx) => manager.create(TripWaypoint, {
        trip_day_id: dayRow.id, sequence: idx,
        location: latLngToPoint({ lat: w.lat, lng: w.lng }),
        name: w.name ?? null, waypoint_type: w.type,
      }));
      if (waypointRows.length > 0) await manager.save(waypointRows);
    }

    await manager.update(Trip, { id: tripId }, { status: 'planned', num_days: days.length, updated_at: new Date() });
  });

  const detail = await this.getDetail(userId, tripId);
  this.events.emitToTrip(tripId, 'trip:updated', detail);
  await this.activity.recordSafe(tripId, userId, 'trip_updated', { fields: ['manual_route'] });
  return detail;
}
```

Add `In` to the `typeorm` import. Confirm `num_days` is a `Trip` column (grep `num_days` in `trip.entity.ts`); if not, drop that field from the update.

- [ ] **Step 3: Update existing saveManualRoute tests to the days[] shape**

Every `saveManualRoute(...)` call in the spec must wrap its `waypoints` in `{ days: [{ dayNumber: 1, startLinked: false, waypoints: [...] }], options }`. The per-day validation tests (no end, duplicate start, out-of-order) stay valid — move their waypoints under a `days[0]`. Mirror the lock/`manager.find`/`manager.findOne` mock sequence; the new `manager.find(TripDay, …)` call returns existing days for the unscope step.

- [ ] **Step 4: Add a multi-day test**

```ts
it("saves a two-day route, routing + persisting each day with start_linked", async () => {
  memberRepo.findOne.mockResolvedValueOnce({
    trip_id: TRIP_ID,
    user_id: OWNER_ID,
    role: "owner",
  } as TripMember);
  routingProvider.route
    .mockResolvedValueOnce({
      geometry: [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
      ],
      distance_km: 10,
      duration_min: 20,
    })
    .mockResolvedValueOnce({
      geometry: [
        { lat: 1, lng: 1 },
        { lat: 2, lng: 2 },
      ],
      distance_km: 12,
      duration_min: 24,
    });
  // …mock enrichment.aggregate twice; mock the transaction manager (find/findOne/create/save/update/delete)…
  await service.saveManualRoute(OWNER_ID, TRIP_ID, {
    days: [
      {
        dayNumber: 1,
        startLinked: false,
        waypoints: [
          { lat: 0, lng: 0, type: "start" },
          { lat: 1, lng: 1, type: "end" },
        ],
      },
      {
        dayNumber: 2,
        startLinked: true,
        waypoints: [
          { lat: 1, lng: 1, type: "start" },
          { lat: 2, lng: 2, type: "end" },
        ],
      },
    ],
  });
  expect(routingProvider.route).toHaveBeenCalledTimes(2);
  // assert two TripDay creates, the second with start_linked: true
});
```

(Match the transaction-manager mock harness already used by the Phase 1 saveManualRoute tests.)

- [ ] **Step 5: Run** `pnpm --filter @tarmoto/backend exec jest trips.service` → all green. Run `pnpm --filter @tarmoto/backend build`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/trips/trips.service.ts apps/backend/src/modules/trips/trips.service.spec.ts
git commit -m "feat(backend): persist all days on multi-day route save"
```

---

## Task 5: OpenAPI + companion client regen

**Files:**

- Regenerate: `packages/openapi/openapi.yaml`, `packages/openapi-client/src/generated/schema.d.ts`
- Modify: `apps/companion/src/lib/api.ts` (`SaveRouteBody` resolves to the new shape automatically)

**Interfaces:**

- Produces: the generated `SaveRouteBody` type now carries `{ days: [...], options? }`.

- [ ] **Step 1: Build backend + regenerate**

Run: `pnpm --filter @tarmoto/backend build && pnpm openapi:gen`.

- [ ] **Step 2: Verify the schema changed**

Run: `grep -n "SaveRouteDay\|start_linked\|startLinked" packages/openapi/openapi.yaml | head`. Expect the new day shape present.

- [ ] **Step 3: Typecheck the companion against the new client**

Run: `pnpm --filter @tarmoto/companion exec tsc --noEmit`. The single-day `handleSaveRoute` call will now fail to typecheck (it sends `waypoints`, not `days`) — this is EXPECTED and fixed in Task 10. If tsc errors ONLY in `page.tsx` at the `tripsApi.saveRoute` call, proceed; any other file erroring is a regression to fix here.

- [ ] **Step 4: Commit**

```bash
git add packages/openapi/openapi.yaml packages/openapi-client/src/generated/schema.d.ts
git commit -m "chore(openapi): regenerate client for multi-day save-route"
```

---

## Task 6: Companion — `TripDay.startLinked` type + per-day staleness store fields

**Files:**

- Modify: `apps/companion/src/lib/types.ts` (`TripDay`)
- Modify: `apps/companion/src/stores/trip.ts` (state shape: `selectedDayIndex`, `stalePreviewDays`, replace `routePreviewStale`)
- Modify: `apps/companion/src/lib/trip-adapters.ts` (or wherever `tripFromDetail` maps day responses — grep `tripFromDetail`) to carry `startLinked` from the response
- Test: `apps/companion/src/stores/trip.test.ts`

**Interfaces:**

- Produces: `TripDay.startLinked?: boolean`; store `selectedDayIndex: number`, `stalePreviewDays: number[]`, `setSelectedDay`, and helper `isDayStale`. `routePreviewStale` boolean is REMOVED — every reader migrates to `stalePreviewDays`.

- [ ] **Step 1: Add `startLinked` to the `TripDay` type**

In `types.ts`, add to `TripDay`: `startLinked?: boolean;`.

- [ ] **Step 2: Map it in the detail adapter**

In `tripFromDetail`'s day mapping, add `startLinked: d.start_linked ?? false,`.

- [ ] **Step 3: Replace `routePreviewStale` with `stalePreviewDays` in the store shape**

- Remove `routePreviewStale: boolean` from `TripState`; add `selectedDayIndex: number;`, `stalePreviewDays: number[];`, `setSelectedDay: (index: number) => void;`.
- Init: `selectedDayIndex: 0`, `stalePreviewDays: []`.
- Add helpers near `updatePlannerDayRoute`:

```ts
function markDayStale(staleDays: number[], dayNumber: number): number[] {
  return staleDays.includes(dayNumber) ? staleDays : [...staleDays, dayNumber];
}
function clearDayStale(staleDays: number[], dayNumber: number): number[] {
  return staleDays.filter((n) => n !== dayNumber);
}
```

- `setActiveTrip`: reset `stalePreviewDays: []`, `selectedDayIndex: 0`.
- `setSelectedDay: (index) => set({ selectedDayIndex: index })`.
- Also add `export const MAX_TRIP_DAYS = 14;` at the top of `trip.ts` (companion mirror of the backend cap) — Tasks 8 and 9 reference it instead of a literal.
- **`markRouteDirty`** is called on an avoid-option toggle, which is **trip-level** (options apply to every day), so it must mark **all** days stale: `set((s) => ({ routeDirty: true, stalePreviewDays: (s.activeTrip?.days ?? []).map((d) => d.dayNumber) }))`.

> NOTE: Tasks 7–9 migrate every other former `routePreviewStale: true/false` write to the per-day equivalent. In THIS task, make the minimal edits so it compiles: where Phase 1 set `routePreviewStale: true` on a waypoint mutation, temporarily set the SELECTED day stale via `markDayStale(get().stalePreviewDays, get().activeTrip?.days[get().selectedDayIndex]?.dayNumber ?? 1)`; where it set `false`, clear that day. Tasks 7–9 refine.

- [ ] **Step 4: Write tests for the new fields**

```ts
it("tracks selectedDayIndex and resets it + stale days on setActiveTrip", () => {
  const s = useTripStore.getState();
  s.setSelectedDay(2);
  expect(useTripStore.getState().selectedDayIndex).toBe(2);
  s.setActiveTrip(/* a 1-day trip fixture */);
  expect(useTripStore.getState().selectedDayIndex).toBe(0);
  expect(useTripStore.getState().stalePreviewDays).toEqual([]);
});
```

- [ ] **Step 5: Run** `pnpm --filter @tarmoto/companion exec tsc --noEmit` (page.test mock will need `stalePreviewDays` instead of `routePreviewStale` — update the `TripStoreSnapshot` type + init there too) and `pnpm --filter @tarmoto/companion exec vitest run stores/trip` → green.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/lib/types.ts apps/companion/src/lib/trip-adapters.ts apps/companion/src/stores/trip.ts apps/companion/src/stores/trip.test.ts "apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx"
git commit -m "feat(companion): per-day route staleness + store-tracked selected day"
```

---

## Task 7: Companion — selected-day-aware waypoint mutations

**Files:**

- Modify: `apps/companion/src/stores/trip.ts` (`placeWaypoint`, `setWaypointType`, `removeWaypointById`, `applyRouteResult`, `routingWaypoints`, `saveWaypoints`)
- Test: `apps/companion/src/stores/trip.test.ts`

**Interfaces:**

- Consumes: `selectedDayIndex`, `stalePreviewDays` (Task 6).
- Produces: all six operate on `days[selectedDayIndex]`; mutations set that day stale; `applyRouteResult` clears that day; `routingWaypoints()`/`saveWaypoints()` read the selected day.

- [ ] **Step 1: Generalize the read helpers**

`routingWaypoints()` and `saveWaypoints()`: replace `const day = activeTrip.days[0]` with `const day = activeTrip.days[get().selectedDayIndex]`.

- [ ] **Step 2: Generalize the mutations**

In `placeWaypoint`, `setWaypointType`, `removeWaypointById`: replace `days[0]` / `activeTrip.days[0]` with `const idx = state.selectedDayIndex; const day = days[idx]` and write `days[idx] = updatePlannerDayRoute(...)`. Where each set `routePreviewStale: true`, instead set `stalePreviewDays: markDayStale(state.stalePreviewDays, day.dayNumber)`. (Note: `placeWaypoint` still mints a draft trip when none exists — keep that, selecting day index 0.)

- [ ] **Step 3: Generalize `applyRouteResult`**

`applyRouteResult` must target a specific day. Change its signature to `applyRouteResult: (dayNumber: number, result: RouteResponse) => void` (the page passes the day it routed). Write geometry into the matching day; set `stalePreviewDays: clearDayStale(state.stalePreviewDays, dayNumber)`.

- [ ] **Step 4: Tests**

```ts
it("places a waypoint on the selected day, not day 0", () => {
  // seed a 2-day trip, setSelectedDay(1), placeWaypoint set-start
  // expect days[1].waypoints to have the start, days[0] unchanged, stalePreviewDays includes day 2's number
});
it("applyRouteResult writes geometry to the targeted day and clears its staleness", () => {
  // mark day 2 stale, applyRouteResult(2, result) -> days[1].routeGeometry set, stalePreviewDays excludes 2
});
```

- [ ] **Step 5: Run** vitest `stores/trip` → green; `tsc --noEmit` (the page's `applyRouteResult` call now needs a dayNumber arg — fixed in Task 9; if tsc errors only there, OK).

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/stores/trip.ts apps/companion/src/stores/trip.test.ts
git commit -m "feat(companion): route waypoint mutations to the selected day"
```

---

## Task 8: Companion — day lifecycle + linked-start sync

**Files:**

- Modify: `apps/companion/src/stores/trip.ts` (`addDay`, `removeDay`, `relinkDayStart`, end-edit cascade)
- Test: `apps/companion/src/stores/trip.test.ts`

**Interfaces:**

- Consumes: `createEmptyPlannerDay`, `updatePlannerDayRoute`, `markDayStale`, `filterRoutingWaypoints`.
- Produces: `addDay()`, `removeDay(index)`, `relinkDayStart(index)`; the invariant "linked day's start mirrors prev day's end".

- [ ] **Step 1: Add a central linked-start sync helper**

```ts
// After mutating day at `idx`, if it changed its `end`, push that end into the
// next day's start when the next day is linked, marking both days stale.
function syncLinkedStart(
  days: TripDay[],
  idx: number,
  staleDays: number[],
): { days: TripDay[]; stale: number[] } {
  const next = days[idx + 1];
  if (!next || !next.startLinked) return { days, stale: staleDays };
  const end = days[idx].waypoints.find((w) => w.type === "end");
  const nextWaypoints = [...next.waypoints];
  const startIdx = nextWaypoints.findIndex((w) => w.type === "start");
  if (!end) return { days, stale: staleDays }; // no end yet → linked start stays empty
  const seededStart: Waypoint = {
    id: nextWaypoints[startIdx]?.id ?? `link-${next.dayNumber}`,
    name: "Start",
    type: "start",
    location: { ...end.location },
  };
  if (startIdx >= 0) nextWaypoints[startIdx] = seededStart;
  else nextWaypoints.unshift(seededStart);
  const updated = [...days];
  updated[idx + 1] = updatePlannerDayRoute(
    { ...next, waypoints: nextWaypoints },
    nextWaypoints,
    undefined,
  );
  return { days: updated, stale: markDayStale(staleDays, next.dayNumber) };
}
```

Call `syncLinkedStart` from the three mutations (Task 7) AFTER writing `days[idx]`, whenever the mutation could have changed the selected day's `end` (place set-end / set-new-end, remove of an end, type change to/from end). Simplest: always call it; it's a no-op when the next day isn't linked or the end is unchanged.

- [ ] **Step 2: `addDay`**

```ts
addDay: () => set((state) => {
  const trip = state.activeTrip;
  if (!trip) return state;
  if (trip.days.length >= MAX_TRIP_DAYS) return state;
  const prev = trip.days[trip.days.length - 1];
  const newDay = createEmptyPlannerDay(prev.dayNumber + 1);
  newDay.startLinked = true;
  const prevEnd = prev.waypoints.find((w) => w.type === 'end');
  if (prevEnd) newDay.waypoints = [{ id: `link-${newDay.dayNumber}`, name: 'Start', type: 'start', location: { ...prevEnd.location } }];
  return {
    activeTrip: { ...trip, days: [...trip.days, newDay], updatedAt: new Date().toISOString() },
    selectedDayIndex: trip.days.length, // select the new day
    routeDirty: true,
  };
}),
```

- [ ] **Step 3: `removeDay`**

```ts
removeDay: (index) => set((state) => {
  const trip = state.activeTrip;
  if (!trip || trip.days.length <= 1) return state; // min 1
  const days = trip.days.filter((_, i) => i !== index)
    .map((d, i) => ({ ...d, dayNumber: i + 1 })); // renumber contiguously
  let stale = state.stalePreviewDays;
  // re-evaluate the boundary at `index`: if the day now at `index` is linked, re-seed from its new predecessor
  let result = { days, stale };
  if (index > 0 && index < days.length && days[index].startLinked) {
    result = syncLinkedStart(days, index - 1, stale);
  }
  const selectedDayIndex = Math.min(state.selectedDayIndex, result.days.length - 1);
  return { activeTrip: { ...trip, days: result.days, updatedAt: new Date().toISOString() }, stalePreviewDays: result.stale, selectedDayIndex, routeDirty: true };
}),
```

- [ ] **Step 4: `relinkDayStart`**

```ts
relinkDayStart: (index) => set((state) => {
  const trip = state.activeTrip;
  if (!trip || index < 1) return state;
  const days = trip.days.map((d, i) => (i === index ? { ...d, startLinked: true } : d));
  const { days: synced, stale } = syncLinkedStart(days, index - 1, state.stalePreviewDays);
  return { activeTrip: { ...trip, days: synced, updatedAt: new Date().toISOString() }, stalePreviewDays: stale, routeDirty: true };
}),
```

- [ ] **Step 5: Override on manual start placement**

In `placeWaypoint` (Task 7), when the action is `set-start`/`set-new-start` on a day with index ≥ 1, set that day's `startLinked = false` (override) in the written day object.

- [ ] **Step 6: Tests**

```ts
it("addDay appends a linked day seeded from the previous end and selects it", () => {
  /* … */
});
it("addDay is capped at 14 days", () => {
  /* … */
});
it("editing day 1 end moves a linked day 2 start and marks both stale", () => {
  /* place set-end on day 1; expect day2.start.location === day1.end.location; stale includes 1 and 2 */
});
it("placing a start on day 2 overrides the link (startLinked=false) and stops mirroring", () => {
  /* … */
});
it("relinkDayStart re-seeds and re-mirrors", () => {
  /* … */
});
it("removeDay renumbers and keeps a linked boundary consistent; min 1 day", () => {
  /* … */
});
```

- [ ] **Step 7: Run** vitest `stores/trip` → green.

- [ ] **Step 8: Commit**

```bash
git add apps/companion/src/stores/trip.ts apps/companion/src/stores/trip.test.ts
git commit -m "feat(companion): day lifecycle + live overnight link sync"
```

---

## Task 9: Companion — planner page: real day tabs + per-day routing + save gating

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx`
- Test: `apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx`

**Interfaces:**

- Consumes: store `selectedDayIndex`, `setSelectedDay`, `addDay`, `removeDay`, `relinkDayStart`, `stalePreviewDays`, `applyRouteResult(dayNumber, result)`.
- Produces: dynamic day tabs from `activeTrip.days`; routes the selected day live; per-day completeness save gate.

- [ ] **Step 1: Replace the static `daysTabs` with the real days**

Remove the hardcoded `daysTabs` array (lines ~478–495). Render one tab per `activeTrip.days`, each showing `Day N` + a `distanceKm`/`durationMinutes` summary. Use store `selectedDayIndex`/`setSelectedDay` (remove the page-local `useState(0)`). Add a "+ Add day" button (calls `addDay`, disabled at 14 days) and a per-day remove control (calls `removeDay`, hidden when `days.length === 1`). For a linked-overridden day (index ≥ 1, `startLinked === false`), show a "Link to previous day" button calling `relinkDayStart(index)`.

- [ ] **Step 2: Route the selected day; pass dayNumber to applyRouteResult**

`routingWaypoints`/`routeOptions` already read the selected day via the store. Change the `usePlannerRouting` result handler to call `applyRouteResult(selectedDay.dayNumber, result)`. Gate live routing with `enabled = routeDirty && selectedDay && stalePreviewDays.includes(selectedDay.dayNumber)` so only a stale selected day routes. (Cascaded neighbor staleness is handled when the rider switches to that day — acceptable for phase 2; document this in a code comment.)

- [ ] **Step 3: Generalize `canSaveRoute`**

Add a completeness helper in the page (or import from store):

```ts
const completeness = (d: TripDay): "empty" | "incomplete" | "complete" => {
  const routing = filterRoutingWaypoints(d.waypoints);
  if (d.waypoints.length === 0) return "empty";
  const hasStart = routing.some((w) => w.type === "start");
  const hasEnd = routing.some((w) => w.type === "end");
  return hasStart && hasEnd && routing.length >= 2 ? "complete" : "incomplete";
};
const dayStates = (activeTrip?.days ?? []).map(completeness);
const canSaveRoute =
  dayStates.some((s) => s === "complete") &&
  !dayStates.some((s) => s === "incomplete") &&
  stalePreviewDays.length === 0 &&
  routeDirty;
```

- [ ] **Step 4: Tests**

Extend `page.test.tsx`:

```ts
it("renders one tab per trip day and switches the selected day", () => {
  /* 2-day fixture, click day 2 tab, expect setSelectedDay(1) */
});
it("disables Save when any day is incomplete", () => {
  /* day 2 has start only */
});
it("disables Save while a day preview is stale", () => {
  /* stalePreviewDays: [2] */
});
it("enables Save when all non-empty days are complete and fresh", () => {
  /* … */
});
it("shows Add day and caps at 14", () => {
  /* … */
});
```

Update the `usePlannerRouting` mock + `TripStoreSnapshot` to the new fields (`stalePreviewDays`, `selectedDayIndex`, `addDay`, etc.).

- [ ] **Step 5: Run** `tsc --noEmit`, `vitest run trips/planner/page`, `eslint .` → green.

- [ ] **Step 6: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/trips/planner/page.tsx" "apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx"
git commit -m "feat(companion): dynamic day tabs, per-day routing, multi-day save gate"
```

---

## Task 10: Companion — multi-day save payload

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/trips/planner/page.tsx` (`handleSaveRoute`)
- Modify: `apps/companion/src/stores/trip.ts` — add `saveDays()` selector returning the per-day save payload
- Test: `apps/companion/src/stores/trip.test.ts`, `apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx`

**Interfaces:**

- Consumes: `tripsApi.saveRoute(tripId, { days, options })` (Task 5 client).
- Produces: store `saveDays(): { dayNumber: number; startLinked: boolean; waypoints: {lat,lng,name?,type}[] }[]` (drops empty days, renumbers, maps waypoint types via `LOCAL_TO_BACKEND_WAYPOINT_TYPE`).

- [ ] **Step 1: Add `saveDays()` to the store**

```ts
saveDays: () => {
  const { activeTrip } = get();
  if (!activeTrip) return [];
  return activeTrip.days
    .filter((d) => d.waypoints.length > 0) // drop empties
    .map((d, i) => ({
      dayNumber: i + 1, // renumber contiguously
      startLinked: d.startLinked ?? false,
      waypoints: activePlannerSaveWaypoints(d.waypoints),
    }));
},
```

- [ ] **Step 2: Rewrite `handleSaveRoute` payload**

Replace `const wps = useTripStore.getState().saveWaypoints()` with `const days = useTripStore.getState().saveDays()`. Guard: `if (days.length === 0) { toast.error(...); return; }`. Set the create payload's `num_days: days.length` (not `1`). Call `tripsApi.saveRoute(tripId, { days, options: routeOptions })`.

- [ ] **Step 3: Tests**

```ts
// store
it("saveDays drops empty days, renumbers, and maps waypoint types", () => {
  /* 3 days, middle empty → 2 days numbered 1,2 */
});
// page
it("saves a multi-day payload with days[] and num_days from day count", async () => {
  /* assert tripsApi.saveRoute called with { days: [...len 2...] } */
});
```

- [ ] **Step 4: Run** `tsc --noEmit`, `vitest run` (full companion), `eslint .` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/companion/src/stores/trip.ts apps/companion/src/stores/trip.test.ts "apps/companion/src/app/(dashboard)/trips/planner/page.tsx" "apps/companion/src/app/(dashboard)/trips/planner/page.test.tsx"
git commit -m "feat(companion): send multi-day route payload on save"
```

---

## Task 11: Companion — map renders all days color-coded + focus toggle

**Files:**

- Modify: `apps/companion/src/components/TripPlannerMap.tsx`
- Modify: the route/waypoint collection builders (grep `buildTripPlannerRouteCollection` / `buildTripPlannerWaypointCollection` — likely `apps/companion/src/lib/trip-planner-map.ts` or similar)
- Test: the builders' unit test (same file's `.test.ts`) + `TripPlannerMap.test.tsx`

**Interfaces:**

- Consumes: `trip.days[]`, `selectedDayNumber` prop (already passed), a new `focusSelectedDay: boolean` prop.
- Produces: route features tagged with `dayNumber` + a stable color; the selected day emphasized; a focus toggle hides non-selected days.

- [ ] **Step 1: Tag route/waypoint features per day**

In `buildTripPlannerRouteCollection`, iterate ALL `trip.days` (not just day 0); for each day with `routeGeometry`, push a LineString feature with `properties: { dayNumber, color: DAY_COLORS[(dayNumber - 1) % DAY_COLORS.length], selected: dayNumber === selectedDayNumber }`. Define `export const DAY_COLORS = ['#…', …]` (≥7 distinct, cream-palette-compatible). The builder gains `selectedDayNumber` and `focusSelectedDay` params; when `focusSelectedDay`, emit only the selected day's feature.

- [ ] **Step 2: Color the route line layer by feature property**

Change the `ROUTE_LINE` paint to `'line-color': ['get', 'color']` and `'line-width': ['case', ['get', 'selected'], <emph>, <dim>]` / `'line-opacity': ['case', ['get', 'selected'], 1, 0.45]`. Waypoint markers: include `dayNumber`; the overnight point (a day's `end` equal to the next linked day's `start`) is emitted once.

- [ ] **Step 3: Focus toggle UI**

Add a `focusSelectedDay` boolean state in the planner page, a small toggle control on the map, and pass it through to `TripPlannerMap` → the collection builders. Default `false` (all days shown).

- [ ] **Step 4: Tests**

```ts
// builder
it("emits one route feature per day with a stable color and selected flag", () => {
  /* 2-day fixture */
});
it("emits only the selected day when focusSelectedDay is true", () => {
  /* … */
});
```

Plus a `TripPlannerMap.test.tsx` assertion that the route source receives N day features.

- [ ] **Step 5: Run** `tsc --noEmit`, `vitest run` (companion), `eslint .` → green.

- [ ] **Step 6: Commit**

```bash
git add apps/companion/src/components/TripPlannerMap.tsx apps/companion/src/lib/trip-planner-map.ts apps/companion/src/lib/trip-planner-map.test.ts apps/companion/src/components/TripPlannerMap.test.tsx "apps/companion/src/app/(dashboard)/trips/planner/page.tsx"
git commit -m "feat(companion): render all trip days color-coded with a focus toggle"
```

---

## Task 12: E2E — build, save, reload a two-day trip

**Files:**

- Modify: `apps/companion/e2e/tests/trip-planner.spec.ts`
- Modify: `apps/companion/e2e/mock-backend/server.ts` + `fixtures/index.ts` (PUT /route accepts `days[]`; seed-trip supports 2 days with `start_linked`)

**Interfaces:**

- Consumes: the multi-day `PUT /trips/:id/route` contract + day-tabs UI.

- [ ] **Step 1: Update the mock backend**

`PUT /trips/:id/route` validates/echoes `{ days: [...] }`, returning a detail with each day's `start_linked` + `route_geometry`. `/__test__/seed-trip` accepts a 2-day trip with `start_linked` on day 2.

- [ ] **Step 2: Write the e2e flow**

Seed a 1-day trip, place start+end on day 1, click "Add day" (day 2 seeds its start from day 1's end), place an end on day 2, toggle an avoid option to dirty, Save. Assert: success toast; reload (`?tripId=`) restores 2 day tabs, both routes, and day 2 still linked.

- [ ] **Step 3: Run** `pnpm --filter @tarmoto/companion exec playwright test trip-planner` → green (retries:2, workers:1 already configured).

- [ ] **Step 4: Commit**

```bash
git add apps/companion/e2e/tests/trip-planner.spec.ts apps/companion/e2e/mock-backend/server.ts apps/companion/e2e/mock-backend/fixtures/index.ts
git commit -m "test(companion): e2e multi-day build, save, and reload"
```

---

## Task 13: Docs

**Files:**

- Modify: `docs/specs/` planner section (grep the Phase 1 planner doc) + `docs/process/` migration runbook if it lists migrations
- Modify: `apps/backend/src/modules/trips/` — confirm OpenAPI examples regenerated

**Interfaces:** none.

- [ ] **Step 1: Document the multi-day planner**

Update the product/reference docs that describe the route planner to cover multi-day, the overnight link/override, the focus toggle, and the `start_linked` field. Note the 14-day cap.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs(cross): document multi-day route planner"
```

---

## Final validation (before finishing the branch)

- `pnpm --filter @tarmoto/backend exec jest` (backend) — all green
- `pnpm --filter @tarmoto/backend build`
- `pnpm --filter @tarmoto/companion exec tsc --noEmit`
- `pnpm --filter @tarmoto/companion exec vitest run` — all green
- `pnpm --filter @tarmoto/companion exec eslint .` — 0 errors
- `pnpm --filter @tarmoto/companion exec playwright test trip-planner`
- `pnpm openapi:gen` clean (no uncommitted drift)

Then use **superpowers:finishing-a-development-branch** to open the PR.
