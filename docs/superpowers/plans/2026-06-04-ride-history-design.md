# Ride History — Design Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing 3-tab Ride History feature (All rides / Road map / Compare rides) to the v2 design — primarily layout/UI — wiring the new pieces to real data, keeping existing extra functionality where it doesn't fight the design.

**Architecture:** The feature already exists under `apps/companion/src/app/(dashboard)/rides/` with subroute tabs (`/rides`, `/rides/road-map`, `/rides/compare`), a shared `_RidesScaffold`, a `useRidesQuery` data hook, and a backend `rides` + `exploration` module. This plan: (1) adds two small backend pieces — a params-aware KPI stats endpoint and `max_lean_angle` on the ride summary; (2) restructures the All-rides tab to the design (header actions, time-window pills on the tab row, 4 KPI cards reflecting the active filter window, a full-width table with the design's columns, rows opening the existing detail page); (3) aligns the Road-map sidebar to the design's 4 cards (data already exists via `exploration/stats`); (4) restyles Compare to the design's A/B-card + single metric-table layout, keeping the existing metric data.

**Tech Stack:** NestJS 11 + TypeORM (Postgres/PostGIS), Jest; `@nestjs/swagger` → OpenAPI → `@tarmoto/openapi-client`; `@tarmoto/shared` wire types; Next.js App Router + Zustand + TanStack Query + Tailwind v4; `@tarmoto/ui` atoms (`QualityBars`, `Stamp`, `Mono`, `Card`, `Pill`, `Heading`); MapLibre GL (road-map/compare maps). Companion tests: Vitest + RTL.

**Design source:** screenshots + raw HTML provided in the task thread (All rides, Road map, Compare rides). Cream `#F5EFE6` / ink `#0E0E10` / accent `#FF6A1A`; ink stat card is the first/highlighted one.

**Locked decisions (call-outs):**

1. **Layout/UI is primary.** Adopt the design's structure & components. Where we already have extra data/controls not in the design (advanced min/max + near-place filters, compare's elevation/quality-breakdown), keep them — don't regress capability — but they live within the design's layout.
2. **All-rides list is a full-width table** (no side map; the map is the Road-map tab). Each row navigates to the existing detail page `/rides/[rideId]`. (Detail-page redesign is a separate follow-up — not in this plan.)
3. **KPI cards reflect the ACTIVE FILTER WINDOW** (search + ride-type + time pills + advanced filters), via a new params-aware `GET /rides/stats`. Cards: Distance / Ride time / New roads / Avg quality.
4. **Time-window pills** (All time / This year / Last 90 / Last 30) go on the tab row, right-aligned, on All-rides AND Road-map; **hidden on Compare**. They map to `started_from` (and no upper bound = now).
5. **Honest data gaps** (degrade gracefully, keep layout): per-ride **region** subtext and the per-ride **⚠ hazard count** have no backing data — render ride_type alone for the subtext and omit the hazard badge. (Same philosophy as the home screen.)
6. **Compare keeps its richer metric data**; only the layout changes to the design's A/B-card + single metric table.

---

## Slice B — Backend: ride summary `max_lean_angle` + params-aware KPI stats

### Task B1: Add `max_lean_angle` to the ride summary

**Files:**

- Modify: `apps/backend/src/modules/rides/dto/ride-response.dto.ts` (`RideSummaryDto`)
- Modify: `apps/backend/src/modules/rides/rides.service.ts` (`list()` join + `toSummary`)
- Test: `apps/backend/src/modules/rides/rides.service.spec.ts`

Context: `RideSummaryDto` (line 93) extends `RideResponseDto` and adds `name` + `duration_min`. The design's All-rides table has a **LEAN** column (per-ride max lean), which lives in `ride_stats.max_lean_angle` — currently only on `RideDetailDto` (line 118), not the summary. The `Ride` entity has a `stats` OneToOne relation (confirm the property name in `apps/backend/src/entities/ride.entity.ts`; `getDetail` loads stats separately, the relation exists).

- [ ] **Step 1: Add the field to `RideSummaryDto`** (after `duration_min`):

```ts
export class RideSummaryDto extends RideResponseDto {
  @ApiProperty({ nullable: true })
  name!: string | null;

  @ApiProperty({ nullable: true })
  duration_min!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      "Max lean angle (deg) from the ride's `ride_stats`, surfaced on the " +
      "summary so list views (Ride History table) can show a LEAN column " +
      "without fetching each ride detail. `null` when the ride has no stats.",
  })
  max_lean_angle!: number | null;
}
```

- [ ] **Step 2: Write the failing test** — in `rides.service.spec.ts`, in the `list` describe, assert `max_lean_angle` is mapped. Mirror the file's existing list-test mock style (it stubs `rideRepo.createQueryBuilder` → chainable qb whose `getManyAndCount` resolves `[rides, total]`). Make a fixture ride carry a `stats: { max_lean_angle: 38 }` relation and assert:

```ts
it("surfaces max_lean_angle from ride_stats on the summary", async () => {
  // Arrange the list qb to resolve one ride with a hydrated stats relation:
  //   { id, started_at: <Date>, ride_type:'trip', status:'completed', ...,
  //     stats: { max_lean_angle: 38 } }
  const res = await service.list("user-1", {} as never);
  expect(res.rides[0].max_lean_angle).toBe(38);
});
```

- [ ] **Step 3: Run it → FAIL.** `pnpm --filter @tarmoto/backend test -- rides.service` (expect `max_lean_angle` undefined).

- [ ] **Step 4: Implement** — in `list()`, hydrate the stats relation by adding a left join before `getManyAndCount()`. The current builder is:

```ts
const qb = this.rideRepo
  .createQueryBuilder("ride")
  .where("ride.user_id = :userId", { userId })
  .skip(offset)
  .take(limit);
```

Add the stats join (use the actual relation property — verify it is `ride.stats`):

```ts
const qb = this.rideRepo
  .createQueryBuilder("ride")
  .leftJoinAndSelect("ride.stats", "stats")
  .where("ride.user_id = :userId", { userId })
  .skip(offset)
  .take(limit);
```

Then in `toSummary(ride)`:

```ts
toSummary(ride: Ride): RideSummaryDto {
  return {
    ...this.toRideResponse(ride),
    name: ride.name ?? null,
    duration_min: this.calcDurationMin(ride),
    max_lean_angle: ride.stats?.max_lean_angle ?? null,
  };
}
```

> Note: `toSummary` is also called by `importGpx`/`rename` where `stats` isn't loaded → `max_lean_angle` is `null` there. Acceptable (those flows don't need it). If `leftJoinAndSelect` with `.skip()/.take()` triggers TypeORM's distinct-id pagination, that's fine for a OneToOne (no row multiplication). Confirm the relation name; if it's not `stats`, fix the join alias + `toSummary` accessor.

- [ ] **Step 5: Run it → PASS**, then build: `pnpm --filter @tarmoto/backend test -- rides.service && pnpm --filter @tarmoto/backend build`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/rides/dto/ride-response.dto.ts apps/backend/src/modules/rides/rides.service.ts apps/backend/src/modules/rides/rides.service.spec.ts
git commit -m "feat(backend): surface max_lean_angle on the ride summary for the history table"
```

### Task B2: Params-aware `GET /rides/stats` KPI endpoint

**Files:**

- Create: `packages/shared/src/ride-stats.ts` + export in `packages/shared/src/index.ts`
- Create: `apps/backend/src/modules/rides/dto/ride-stats.dto.ts`
- Modify: `apps/backend/src/modules/rides/rides.service.ts` (add `stats()` method reusing `applyRidesFilters`)
- Modify: `apps/backend/src/modules/rides/rides.controller.ts` (route)
- Test: `apps/backend/src/modules/rides/rides.service.spec.ts`

Context: The All-rides KPI cards must reflect the active filter window. The list endpoint already centralizes filtering in `private applyRidesFilters(qb, query)` (type, started_from/to, min/max distance, min/max quality, near, search). A sibling aggregation endpoint that runs the SAME filters returns the 4 KPIs.

- [ ] **Step 1: Shared wire type** — `packages/shared/src/ride-stats.ts`:

```ts
/**
 * Aggregate KPIs for a filtered set of the rider's rides, served by
 * `GET /rides/stats` with the SAME query params as `GET /rides`. Drives the
 * Ride History "All rides" KPI cards so they reflect the active filter
 * window (search / ride-type / time / distance / quality). Metric units.
 */
export interface RideStats {
  /** Sum of `distance_km` across the filtered, completed rides. */
  total_distance_km: number;
  /** Total ride time (hours) across the filtered, completed rides. */
  total_hours: number;
  /** Distinct road segments touched by the filtered rides ("new roads"). */
  new_roads: number;
  /** Distance-weighted average road quality (0–5), or null if unscored. */
  avg_quality: number | null;
  /** Number of rides matched by the filter (for context / empty states). */
  ride_count: number;
}
```

Add `export * from "./ride-stats";` to `packages/shared/src/index.ts` (alphabetical, after `./regions` or wherever it sorts). Build: `pnpm --filter @tarmoto/shared build`.

- [ ] **Step 2: DTO** — `apps/backend/src/modules/rides/dto/ride-stats.dto.ts`:

```ts
import { ApiProperty } from "@nestjs/swagger";
import type { RideStats } from "@tarmoto/shared";

export class RideStatsDto implements RideStats {
  @ApiProperty({ description: "Sum of distance_km across filtered rides." })
  total_distance_km!: number;

  @ApiProperty({
    description: "Total ride time (hours) across filtered rides.",
  })
  total_hours!: number;

  @ApiProperty({ description: "Distinct road segments touched (new roads)." })
  new_roads!: number;

  @ApiProperty({
    nullable: true,
    description: "Distance-weighted avg quality (0–5).",
  })
  avg_quality!: number | null;

  @ApiProperty({ description: "Number of rides matched by the filter." })
  ride_count!: number;
}
```

- [ ] **Step 3: Failing service test** — in `rides.service.spec.ts` add a `stats` describe. The method runs two queries: a base aggregate over `rides` (sum/avg/count) and a distinct-segments count joining `ride_segments`. Mirror the file's qb-mock style; assert mapping + that `applyRidesFilters` predicates are applied (e.g. a `ride_type =` andWhere when `type` is passed). Skeleton:

```ts
describe("stats", () => {
  it("aggregates distance/hours/quality/count + distinct roads for the filter", async () => {
    // qb #1 (aggregate getRawOne) -> { km:'1284', hours:'32', quality:'4.1', count:'8' }
    // qb #2 (distinct roads getRawOne) -> { roads:'47' }
    const res = await service.stats("user-1", { type: "trip" } as never);
    expect(res.total_distance_km).toBe(1284);
    expect(res.total_hours).toBe(32);
    expect(res.new_roads).toBe(47);
    expect(res.avg_quality).toBeCloseTo(4.1);
    expect(res.ride_count).toBe(8);
  });
});
```

- [ ] **Step 4: Run → FAIL** (`stats is not a function`).

- [ ] **Step 5: Implement `stats()`** in `RidesService` (import `RideStatsDto`). Reuse `applyRidesFilters` on both builders:

```ts
async stats(userId: string, query: ListRidesDto): Promise<RideStatsDto> {
  const base = (): SelectQueryBuilder<Ride> =>
    this.applyRidesFilters(
      this.rideRepo
        .createQueryBuilder('ride')
        .where('ride.user_id = :userId', { userId }),
      query,
    );

  const [agg, roadsRow] = await Promise.all([
    base()
      .select('COALESCE(SUM(ride.distance_km), 0)', 'km')
      .addSelect(
        "COALESCE(SUM(EXTRACT(EPOCH FROM (ride.ended_at - ride.started_at)) / 3600.0), 0)",
        'hours',
      )
      // Distance-weighted average quality over rides that have a quality.
      .addSelect(
        'CASE WHEN SUM(ride.distance_km) FILTER (WHERE ride.avg_road_quality IS NOT NULL) > 0 ' +
          'THEN SUM(ride.avg_road_quality * ride.distance_km) ' +
          '/ SUM(ride.distance_km) FILTER (WHERE ride.avg_road_quality IS NOT NULL) ' +
          'ELSE AVG(ride.avg_road_quality) END',
        'quality',
      )
      .addSelect('COUNT(*)', 'count')
      .getRawOne<{ km: string; hours: string; quality: string | null; count: string }>(),
    base()
      .innerJoin('ride_segments', 'seg', 'seg.ride_id = ride.id')
      .select('COUNT(DISTINCT seg.road_segment_id)', 'roads')
      .andWhere('seg.road_segment_id IS NOT NULL')
      .getRawOne<{ roads: string }>(),
  ]);

  return {
    total_distance_km: Math.round(parseFloat(agg?.km ?? '0')),
    total_hours: Math.round(parseFloat(agg?.hours ?? '0')),
    new_roads: parseInt(roadsRow?.roads ?? '0', 10),
    avg_quality:
      agg?.quality != null
        ? Math.round(parseFloat(agg.quality) * 10) / 10
        : null,
    ride_count: parseInt(agg?.count ?? '0', 10),
  };
}
```

> `applyRidesFilters` uses the `ride` alias (the list builder is `createQueryBuilder('ride')`), so both builders must use `'ride'`. Confirm `SelectQueryBuilder` is already imported in the service (it is — used by `applyRidesFilters`). If `applyRidesFilters` references `ride.route_geom`/etc. only conditionally on query fields, an empty query yields a plain user-scoped aggregate — correct.

- [ ] **Step 6: Controller route** — in `rides.controller.ts`, add BEFORE the `:rideId` routes (literal path must win over `:rideId`), near the `tracks` route:

```ts
@Get('stats')
@ApiOperation({ summary: 'Aggregate KPIs for a filtered set of rides' })
@ApiResponse({ status: 200, type: RideStatsDto })
async stats(
  @Req() req: express.Request,
  @Query() query: ListRidesDto,
): Promise<RideStatsDto> {
  return this.ridesService.stats(req.user!.userId, query);
}
```

Import `RideStatsDto` at the top alongside the other ride DTOs.

- [ ] **Step 7: Run test → PASS**, build: `pnpm --filter @tarmoto/backend test -- rides.service && pnpm --filter @tarmoto/backend build`

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/ride-stats.ts packages/shared/src/index.ts apps/backend/src/modules/rides/dto/ride-stats.dto.ts apps/backend/src/modules/rides/rides.service.ts apps/backend/src/modules/rides/rides.controller.ts apps/backend/src/modules/rides/rides.service.spec.ts
git commit -m "feat(backend): add params-aware GET /rides/stats KPI endpoint"
```

### Task B3: Regenerate OpenAPI client

- [ ] **Step 1:** `pnpm openapi:gen`
- [ ] **Step 2:** Verify: `grep -c "/rides/stats" packages/openapi/openapi.yaml` ≥ 1 and `grep -c "max_lean_angle" packages/openapi-client/src/generated/schema.d.ts` ≥ 1.
- [ ] **Step 3:** Regenerate the Postman collection too (it's a tracked artifact; the earlier home-screen PR set this precedent). Because `pnpm postman:gen` reshuffles route order, prefer a **surgical** update: only add the `/rides/stats` request item + (no description changes needed here). If that's disproportionate, run `pnpm postman:gen` and accept the diff. Commit:

```bash
git add packages/openapi-client/src/generated/schema.d.ts packages/openapi/postman/tarmoto-api.postman_collection.json
git commit -m "chore(openapi): regenerate for ride summary lean + /rides/stats"
```

---

## Slice A — All rides tab

### Task A1: Shared header actions + time-window pills on the tab row

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/_RidesScaffold.tsx`
- Modify: `apps/companion/src/app/(dashboard)/rides/_RidesTabsBar.tsx`
- Create: `apps/companion/src/app/(dashboard)/rides/_components/TimeWindowPills.tsx`

Context: The design header has two actions top-right: **Share map** (ghost, share icon) and **Export CSV** (solid ink, arrow icon). The tab row holds the 3 tabs left, and the time-window pills right (All time / This year / Last 90 / Last 30) — shown on All-rides + Road-map, hidden on Compare.

- [ ] **Step 1: Time-window pills component** — `TimeWindowPills.tsx`. A controlled segmented pill group; maps each option to a `started_from` ISO date (or null for "All time"):

```tsx
"use client";
import { Pill } from "@tarmoto/ui";

export type TimeWindow = "all" | "year" | "90d" | "30d";

const OPTIONS: { key: TimeWindow; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "year", label: "This year" },
  { key: "90d", label: "Last 90" },
  { key: "30d", label: "Last 30" },
];

/** ISO `YYYY-MM-DD` lower bound for a window, or null for "all". */
export function windowStartISO(w: TimeWindow, now = new Date()): string | null {
  if (w === "all") return null;
  const d = new Date(now);
  if (w === "year") return `${now.getUTCFullYear()}-01-01`;
  d.setUTCDate(d.getUTCDate() - (w === "90d" ? 90 : 30));
  return d.toISOString().slice(0, 10);
}

export function TimeWindowPills({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  return (
    <div className="inline-flex gap-1.5">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={
            value === o.key
              ? "rounded-full bg-ink px-2.5 py-[5px] text-[11px] font-bold text-cream"
              : "rounded-full border border-line-strong px-2.5 py-[5px] text-[11px] font-bold text-ink transition hover:bg-paper"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

> Verify `Pill` import is actually needed; the inline buttons above don't use it — drop the import if unused. If a shared segmented-control exists in `@tarmoto/ui` matching the home KPI/pill style, prefer it.

- [ ] **Step 2: Header actions** — in `_RidesScaffold.tsx`, render the right-slot action buttons (the scaffold already supports a right slot per the exploration). Wire **Export CSV** to the existing `GET /api/v1/rides/export.csv` (open the URL / trigger download via the existing export menu if one exists; reuse the rides page's existing CSV export wiring) and **Share map** to the existing exploration/map-share flow used by the road-map page (`mapSharesApi.create()` per the road-map page). Match the design button styles: ghost (`border border-line-strong`, uppercase, share icon) and solid (`bg-ink text-cream`, uppercase, ArrowUpRight icon).

- [ ] **Step 3: Tab row layout** — in `_RidesTabsBar.tsx`, lay the `SubRouteTabs` left and a right-aligned slot for `TimeWindowPills`, hidden on the Compare route. Since the time window must drive both the All-rides query and the Road-map period, lift the `TimeWindow` state to a shared place (URL search param `?window=30d` is the cleanest for subroute persistence). Read/write it via `useSearchParams` + `router.replace`. On `/rides/compare`, render no pills.

- [ ] **Step 4:** `pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion lint`. Commit:

```bash
git add "apps/companion/src/app/(dashboard)/rides/_RidesScaffold.tsx" "apps/companion/src/app/(dashboard)/rides/_RidesTabsBar.tsx" "apps/companion/src/app/(dashboard)/rides/_components/TimeWindowPills.tsx"
git commit -m "feat(companion): ride-history header actions + shared time-window pills"
```

### Task A2: KPI card row reflecting the active filter window

**Files:**

- Create: `apps/companion/src/hooks/useRideStats.ts`
- Create: `apps/companion/src/app/(dashboard)/rides/_components/RideKpiCards.tsx`
- Modify: `apps/companion/src/app/(dashboard)/rides/page.tsx`

- [ ] **Step 1: Hook** `useRideStats.ts` — calls `GET /api/v1/rides/stats` with the SAME query params object the rides list uses (`useRidesQuery` builds these — reuse its param-mapping so filters stay in sync), keyed on those params:

```ts
import { useQuery } from "@tanstack/react-query";
import type { RideStats } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function useRideStats(
  params: Record<string, string | number | undefined>,
): { stats: RideStats | null; loading: boolean } {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const query = useQuery({
    queryKey: ["ride-stats", userId, params],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/rides/stats", {
        params: { query: params },
        signal,
      });
      if (error) throw new Error("ride stats fetch failed");
      return data as unknown as RideStats;
    },
  });
  return { stats: query.data ?? null, loading: query.isLoading };
}
```

> Reuse the exact param object `useRidesQuery` sends to `GET /api/v1/rides` (minus `limit`/`offset`/`sort`/`order`) so the KPI window == the table window. Check `useRidesQuery.ts` for the param-builder and export/reuse it.

- [ ] **Step 2: KPI cards** `RideKpiCards.tsx` — 4-up grid; first card ink/accent (matches the home `KpiTile` look — reuse that style). Distance (km), Ride time (hrs), New roads (DISCOVERED), Avg quality (`x.x` `/ 5`). Hide deltas (the design's "+18% vs March" came from monthly context; here the KPIs are filter-window sums, so show a neutral sublabel like the filter label, or omit the sublabel). Example:

```tsx
"use client";
import type { RideStats } from "@tarmoto/shared";
import { Mono, Stamp } from "@tarmoto/ui";

export function RideKpiCards({ stats }: { stats: RideStats | null }) {
  const cards = [
    {
      label: "Distance",
      value: (stats?.total_distance_km ?? 0).toLocaleString(),
      unit: "KM",
      ink: true,
    },
    { label: "Ride time", value: String(stats?.total_hours ?? 0), unit: "HRS" },
    {
      label: "New roads",
      value: String(stats?.new_roads ?? 0),
      unit: "DISCOVERED",
    },
    {
      label: "Avg quality",
      value: stats?.avg_quality != null ? stats.avg_quality.toFixed(1) : "—",
      unit: "/ 5",
    },
  ];
  return (
    <div className="mb-[18px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className={
            c.ink
              ? "rounded-[14px] border border-ink bg-ink p-[18px] text-cream"
              : "rounded-[14px] border border-line bg-cream p-[18px] text-ink"
          }
        >
          <Stamp tone={c.ink ? "on-dark" : "dim"}>{c.label}</Stamp>
          <div className="mt-2 flex items-baseline gap-1.5">
            <div
              className={`text-[36px] font-extrabold leading-none tracking-[-1px] ${c.ink ? "text-accent" : "text-ink"}`}
            >
              {c.value}
            </div>
            <Mono
              className={
                c.ink
                  ? "text-[11px] text-fg-on-dark-dim"
                  : "text-[11px] text-fg-dim"
              }
            >
              {c.unit}
            </Mono>
          </div>
        </div>
      ))}
    </div>
  );
}
```

> If the home screen's `KpiTile` is exported/extractable, reuse it instead of duplicating. The first (Distance) card is ink+accent per the design.

- [ ] **Step 3: Wire into `page.tsx`** above the filter bar/table; pass the active-filter params. Typecheck + lint. Commit:

```bash
git add apps/companion/src/hooks/useRideStats.ts "apps/companion/src/app/(dashboard)/rides/_components/RideKpiCards.tsx" "apps/companion/src/app/(dashboard)/rides/page.tsx"
git commit -m "feat(companion): ride-history KPI cards driven by the active filter window"
```

### Task A3: Full-width rides table to the design

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/_components/RidesTable.tsx`
- Modify: `apps/companion/src/app/(dashboard)/rides/_components/RideRow.tsx`
- Modify: `apps/companion/src/app/(dashboard)/rides/page.tsx`
- Modify: `apps/companion/src/app/(dashboard)/rides/_components/useRidesQuery.ts` (add `max_lean_angle` to the row type)

Context: design table is a single full-width `Card` with a header row and the columns: **DATE ↓** / **RIDE** (name, bold; second line `TYPE · REGION` in mono mute — region omitted, show `TYPE`; the ⚠ hazard badge is omitted) / **KM** / **DURATION** / **AVG** (avg_speed, no unit) / **LEAN** (`max_lean_angle`°) / **QUALITY** (`QualityBars` from `avg_road_quality`) / trailing `→`. Grid template per design: `90px 1fr 80px 90px 70px 70px 110px 40px`. The whole row is clickable → `/rides/[rideId]`.

- [ ] **Step 1:** Add `max_lean_angle: number | null` to the `RideSummary` row type in `useRidesQuery.ts` (so the client type matches the regenerated DTO).

- [ ] **Step 2: Rebuild `RidesTable` + `RideRow`** to the design. Replace the current editable/`<table>` layout with the cream `Card` + CSS-grid rows matching the home `RecentRidesTable` pattern (reuse `formatDurationCompact`, `formatShortDate`, `scoreToQualityTier` from `@/lib/utils`). Keep the sortable header affordance for DATE/KM/DURATION/AVG/QUALITY (the design shows `DATE ↓`); preserve the existing sort wiring from `useRidesQuery`. Row content:

```tsx
// per row (Link → `/rides/${ride.id}`), grid cols 90px 1fr 80px 90px 70px 70px 110px 40px
<Mono className="text-fg-dim">{formatShortDate(ride.started_at)}</Mono>
<div className="min-w-0">
  <div className="truncate font-bold text-ink">{ride.name ?? formatShortDate(ride.started_at)}</div>
  <Mono className="text-[10px] uppercase text-fg-mute">{ride.ride_type}</Mono>
</div>
<Mono className="font-bold text-ink">{ride.distance_km != null ? Math.round(ride.distance_km) : "—"}</Mono>
<Mono className="text-fg-dim">{formatDurationCompact(ride.duration_min)}</Mono>
<Mono className="text-ink">{ride.avg_speed != null ? Math.round(ride.avg_speed) : "—"}</Mono>
<Mono className="text-ink">{ride.max_lean_angle != null ? `${Math.round(ride.max_lean_angle)}°` : "—"}</Mono>
<span>{quality != null ? <QualityBars q={quality} size={4} /> : <span className="text-fg-mute">—</span>}</span>
<ArrowRight size={14} className="justify-self-end text-fg-mute" />
```

Keep inline rename if you can do it without breaking row navigation (e.g. a pencil affordance that `stopPropagation`s) — but the design shows a plain navigable row, so it's acceptable to drop inline rename here (rename remains available on the detail page). Preserve `role="row"`/`role="cell"` a11y like `RecentRidesTable`.

- [ ] **Step 3: Remove the side map from All-rides** in `page.tsx` — the table becomes full-width (the map is the Road-map tab). Keep the existing **advanced filters** (search, ride-type chips, min/max distance, min/max quality, near-place) in the filter bar above the table per decision #1, but lay them to read like the design's filter row (search left, ride-type segmented chips, the rest can stay in the same bar). The mobile map/list toggle can be removed (no side map now).

- [ ] **Step 4:** Update/repair any `RidesTable`/`RideRow` tests to the new columns. Typecheck + lint + tests: `pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion lint && pnpm --filter @tarmoto/companion test -- rides`. Commit:

```bash
git add "apps/companion/src/app/(dashboard)/rides/_components/RidesTable.tsx" "apps/companion/src/app/(dashboard)/rides/_components/RideRow.tsx" "apps/companion/src/app/(dashboard)/rides/_components/useRidesQuery.ts" "apps/companion/src/app/(dashboard)/rides/page.tsx"
git commit -m "feat(companion): full-width ride-history table matching the v2 design"
```

---

## Slice R — Road map tab

### Task R1: Align the sidebar + map chrome to the design

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/road-map/page.tsx`
- Modify (if needed): `apps/companion/src/app/(dashboard)/rides/road-map/_components/PersonalRoadMap.tsx`

Context: The map (MapLibre) already exists. The design adds/locks: a **legend overlay** top-left ("Ridden (N segments)" accent line + "Unridden" muted line), the **time pills** top-right on the map (now shared via Task A1's `TimeWindowPills` / `?window=` — reconcile with the page's existing `TIME_PERIODS`), and a **right sidebar** of cards in this exact order:

1. **Segments ridden** (ink card, accent number) — `ExplorationStatsDto.ridden_segments`, sub "of `total_segments` in region".
2. **All-time distance** — rider's lifetime distance (km). Source: `GET /users/me/profile` (`total_distance_km`) or exploration; use whichever already provides lifetime distance — confirm and wire.
3. **Region coverage** (accent %) — `ExplorationStatsDto.percent_explored`, sub region label (e.g. "Lombardy · top N%" if available; else just the region name; omit "top N%" if no backing data).
4. **Nearby unridden** — list (name, km, `QualityBars`) from `GET /api/v1/exploration/nearby-unridden` (already wired). Keep the existing list; restyle the rows to the design (name bold, `x.x KM` mono mute, quality bars right).

- [ ] **Step 1:** Restyle the sidebar to the 4 cards above (the page already fetches `explorationApi.getStats()` and `getNearbyUnridden()` — reuse). Drop/merge the current "rides per period" card into this set if it doesn't map; keep the regional breakdown only if it fits the design (the design shows the 4 cards above — prefer those; the regional-breakdown block can be removed or moved below "Nearby unridden" if you want to keep the capability).
- [ ] **Step 2:** Add the legend overlay + ensure the time pills use the shared `?window=` state.
- [ ] **Step 3:** typecheck + lint + `pnpm --filter @tarmoto/companion test -- road-map` (if tests exist). Commit:

```bash
git add "apps/companion/src/app/(dashboard)/rides/road-map/page.tsx" "apps/companion/src/app/(dashboard)/rides/road-map/_components/PersonalRoadMap.tsx"
git commit -m "feat(companion): align road-map sidebar + legend to the v2 design"
```

---

## Slice C — Compare rides tab

### Task C1: Restyle Compare to the design's A/B-card + metric table

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/rides/compare/page.tsx` (+ its `_components` as needed)

Context: design layout = two equal **A/B cards** at top, each with: a header (`RIDE A`/`RIDE B` stamp + a `QualityBars` glyph), a `<select>` ride picker (`DD Mon · Name (NN km)` options), a **route thumbnail** (120px), and a footer row (`NN KM` · `Hh Mm` · `Region`). Below: a single **metric comparison table** (`Card`, grid `180px 1fr 1fr`) with header `METRIC | RIDE A · <name> | RIDE B · <name>` and rows: Distance, Duration, Avg speed, Max lean, Hazards, Region, Ride type. The user said the **amount of data can stay** — so keep the existing richer metric rows (you may keep elevation/quality-breakdown sections BELOW the metric table, or fold their key numbers into extra table rows; do not delete the data, just restyle the top to the design).

- [ ] **Step 1:** Build the two A/B selector cards per the design (reuse the existing ride-picker dropdown logic + auto-select of the two most recent rides). For the route thumbnail, use the existing `RideRouteMap` (real route) sized to 120px height, OR the decorative `MiniRouteSvg` to match the design's sketch look — prefer `RideRouteMap` (real data) since the route geometry is already loaded; it's the honest choice and the design's thumbnail is just illustrative.
- [ ] **Step 2:** Build the single metric `Card` table (grid `180px 1fr 1fr`, alternating row tint `rgba(14,14,16,0.02)`) with the design's rows. Map from the two loaded `RideDetail`s: Distance (`distance_km` km), Duration (`duration_min`), Avg speed (`avg_speed` km/h), Max lean (`max_lean_angle`°), Hazards (omit or 0 if no per-ride hazard count — see decision #5), Region (omit/`—` if unavailable), Ride type (`ride_type`). Keep any extra existing metric rows (elevation gain/loss, curve count) appended — "data can stay".
- [ ] **Step 3:** Keep the existing elevation/quality-breakdown sections if desired, restyled as `Card`s below the metric table (optional; don't delete). typecheck + lint + `pnpm --filter @tarmoto/companion test -- compare`. Commit:

```bash
git add "apps/companion/src/app/(dashboard)/rides/compare/page.tsx"
git commit -m "feat(companion): restyle compare-rides to the v2 A/B + metric-table layout"
```

---

## Final verification (Task V1)

- [ ] **Step 1:** Full gate — `pnpm --filter @tarmoto/backend test && pnpm --filter @tarmoto/companion test && pnpm lint && pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/companion build`.
- [ ] **Step 2:** Boot the stack (`pnpm db:up && pnpm db:migrate && pnpm db:seed`, backend + companion) and log in as `road.hunter@tarmoto.app`. Verify each tab against the design:
  - **All rides**: KPI cards reflect the time-window/type filters (change a pill → numbers + table update together); full-width table with DATE/RIDE(type)/KM/DURATION/AVG/LEAN/QUALITY; a row click opens `/rides/[rideId]`; Export CSV downloads.
  - **Road map**: map renders ridden (accent) vs unridden; legend; time pills; sidebar shows Segments ridden "N of M", All-time distance, Region coverage %, Nearby unridden list.
  - **Compare**: A/B cards with thumbnails + selectors; metric table populates; changing a selection updates the table.
- [ ] **Step 3:** Use `superpowers:finishing-a-development-branch` to open the PR (`feat(companion): align ride-history screen (all rides / road map / compare) to v2 design`), noting the new `/rides/stats` endpoint + `max_lean_angle` summary field as contract changes.

---

## Self-review notes

- **Spec coverage:** All-rides header actions + time pills (A1), KPI cards reflecting the filter window (A2 + B2), full-width table w/ design columns incl. LEAN (A3 + B1), rows→detail (A3), road-map sidebar from `exploration/stats` (R1), compare A/B + metric table (C1). Time pills hidden on compare (A1 Step 3). KPIs reflect active filters (B2 params-aware).
- **Honest gaps flagged:** per-ride region + hazard count omitted (decision #5); "top N%" on region coverage only if backed.
- **Type consistency:** `RideStats` fields (`total_distance_km`, `total_hours`, `new_roads`, `avg_quality`, `ride_count`) identical across shared type, DTO, service return, hook, and cards. `max_lean_angle` consistent across `RideSummaryDto`, the client row type, and the table.
- **Verifications to do during execution (don't assume):** the `Ride.stats` relation property name (B1); that `applyRidesFilters` uses the `ride` alias and is reusable for aggregation (B2); whether lifetime distance for the road-map card comes from `me/profile` vs exploration (R1); the exact `useRidesQuery` param-builder to reuse for `useRideStats` (A2).

```

```
