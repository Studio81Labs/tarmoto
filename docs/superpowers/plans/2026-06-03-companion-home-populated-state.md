# Companion Home — Populated "Returning Rider" State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the companion home screen's populated "returning rider" design (4 monthly KPI tiles, a recent-rides table, the mobile-sync pill, and enriched trip-draft cards) to real backend data, end-to-end.

**Architecture:** Three independent vertical slices, each shippable on its own. Slice A is frontend-only (the rides feed already exists). Slice B adds one new aggregation endpoint (`GET /users/me/stats/monthly`) plus a shared type, and drives both the KPI tiles and the sync pill. Slice C enriches the existing `GET /trips` summary with `distance_km` / `quality_avg` / `passes_count` (all derived live — no migration) and lights up the trip-draft card slots. Backend DTO changes flow to the companion via `pnpm openapi:gen` (dumps `packages/openapi/openapi.yaml`, regenerates `@tarmoto/openapi-client`), which retypes the companion's `api.GET`.

**Tech Stack:** NestJS 11 + TypeORM (PostgreSQL/PostGIS), Jest (backend tests), `@nestjs/swagger` decorators → OpenAPI, `@tarmoto/shared` (canonical wire types), `@tarmoto/openapi-client` (generated typed client + react-query), Next.js App Router + Zustand + TanStack Query + Tailwind v4, `@tarmoto/ui` atoms (`QualityBars`, `Stamp`, `Mono`, `Heading`, `Card`), Vitest + RTL (companion tests).

**Key files (read before starting):**

- Home page: `apps/companion/src/app/(dashboard)/page.tsx` (already has `KpiTileRow`, `SyncPill`, `TripDraftCard`, `SectionHeader` defined; `monthlyStats`/`mobileSync` hardcoded `null`).
- Rides feed (already real): `GET /rides` → `RideSummaryDto` (`apps/backend/src/modules/rides/dto/ride-response.dto.ts:93`). Companion hook `apps/companion/src/hooks/useUserRides.ts` (bulk, for the picker). Existing row UI reference: `apps/companion/src/app/(dashboard)/rides/_components/RideRow.tsx`.
- Stats contract pattern: `packages/shared/src/me-profile.ts` ↔ `apps/backend/src/modules/users/dto/me-profile.dto.ts` ↔ `UsersService.getMeProfile` (`apps/backend/src/modules/users/users.service.ts:76`) ↔ controller `apps/backend/src/modules/users/users.controller.ts:80`.
- Trips: `TripSummaryDto` (`apps/backend/src/modules/trips/dto/trip-response.dto.ts:35`), `TripsService.list`/`toSummary` (`apps/backend/src/modules/trips/trips.service.ts:856`, `:970`), `TripDay` entity (`apps/backend/src/entities/trip-day.entity.ts`), `MountainPass` entity (`apps/backend/src/entities/mountain-pass.entity.ts`). Companion side: `apps/companion/src/lib/types.ts` (`TripSummary`), `apps/companion/src/lib/trip-from-detail.ts` (`tripSummaryFromWire`), card in `page.tsx:520`.

**Design decisions locked (call-outs):**

1. **`avg_road_quality` is a 0–5 scale** (confirmed: `RideRow.tsx:28` rounds it straight into a 1–5 band; `clampQuality` in `packages/ui/src/tokens.ts:55` rounds, not divides). So the design's **QUALITY** bars come from `avg_road_quality`, and the **AVG** column (64/48/…) is **`avg_speed`** (km/h).
2. **Ride hazard badge (⚠ N)** in the design has **no backing data** — there is no per-ride hazard count anywhere. It is **omitted** (honest), consistent with the repo's "hide until the data lands" philosophy. Do not fabricate it.
3. **Trip `passes_count`** has no trip↔pass link today. It is derived live as a spatial count of `mountain_passes` within 2 km of any of the trip's day geometries. If a trip has no day geometry seeded, this is `0` and the card slot hides — honest.
4. **KPI deltas** are returned as raw numbers; the client formats/localizes the "+18% vs last month" strings. The "New roads" tile shows the month's distinct-segment count with a "this month" sublabel (no synthetic "+12").

---

## Slice A — Recent rides table (frontend only, real data)

The `GET /rides` feed already returns everything the table needs. No backend work.

### Task A1: Lightweight recent-rides hook

**Files:**

- Create: `apps/companion/src/hooks/useRecentRides.ts`
- Test: `apps/companion/src/hooks/useRecentRides.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/companion/src/hooks/useRecentRides.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const getMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { GET: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel({ user: { id: "u1" } }),
}));

import { useRecentRides } from "./useRecentRides";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useRecentRides", () => {
  beforeEach(() => getMock.mockReset());

  it("requests the newest rides capped at the limit", async () => {
    getMock.mockResolvedValue({
      data: {
        rides: [
          {
            id: "r1",
            name: "Stelvio",
            started_at: "2026-04-18T08:00:00Z",
            distance_km: 186,
            duration_min: 252,
            avg_speed: 64,
            avg_road_quality: 4.6,
            status: "completed",
            ride_type: "tour",
            ended_at: "2026-04-18T12:12:00Z",
          },
        ],
        total: 1,
      },
      error: undefined,
    });
    const { result } = renderHook(() => useRecentRides(5), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getMock).toHaveBeenCalledWith("/api/v1/rides", {
      params: { query: { limit: 5, sort: "started_at", order: "desc" } },
      signal: expect.anything(),
    });
    expect(result.current.rides).toHaveLength(1);
    expect(result.current.rides[0].name).toBe("Stelvio");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @tarmoto/companion test -- useRecentRides`
Expected: FAIL — `Cannot find module './useRecentRides'`.

- [ ] **Step 3: Implement the hook**

```tsx
// apps/companion/src/hooks/useRecentRides.ts
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { UserRide } from "./useUserRides";

interface RideListResponse {
  rides: UserRide[];
  total: number;
}

/**
 * The signed-in user's most recent rides (newest first), capped at `limit`.
 * Distinct from `useUserRides` (which pages the whole history for the
 * collections picker) — the home screen only needs the last handful, so
 * this issues a single small `sort=started_at desc` query.
 */
export function useRecentRides(limit: number): {
  rides: UserRide[];
  loading: boolean;
  error: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["recent-rides", userId, limit],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/rides", {
        params: { query: { limit, sort: "started_at", order: "desc" } },
        signal,
      });
      if (error) throw new Error("recent rides fetch failed");
      return (data as unknown as RideListResponse).rides ?? [];
    },
  });

  return {
    rides: query.data ?? [],
    loading: query.isLoading,
    error: query.isError,
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @tarmoto/companion test -- useRecentRides`
Expected: PASS.

> If `ListRidesDto` rejects `sort: "started_at"`, confirm the allowed values at `apps/backend/src/modules/rides/dto/list-rides.dto.ts` — the service already special-cases `started_at`/`distance_km`/`avg_road_quality`/`duration_min` (`rides.service.ts:221`), so `started_at` is valid.

- [ ] **Step 5: Commit**

```bash
git add apps/companion/src/hooks/useRecentRides.ts apps/companion/src/hooks/useRecentRides.test.tsx
git commit -m "feat(companion): add useRecentRides hook for the home recent-rides feed"
```

### Task A2: `RecentRidesTable` component

**Files:**

- Create: `apps/companion/src/app/(dashboard)/_home/RecentRidesTable.tsx`
- Test: `apps/companion/src/app/(dashboard)/_home/RecentRidesTable.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/companion/src/app/(dashboard)/_home/RecentRidesTable.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecentRidesTable } from "./RecentRidesTable";
import type { UserRide } from "@/hooks/useUserRides";

const ride: UserRide = {
  id: "r1",
  name: "Stelvio Loop",
  status: "completed",
  ride_type: "tour",
  started_at: "2026-04-18T08:00:00Z",
  ended_at: "2026-04-18T12:12:00Z",
  distance_km: 186,
  duration_min: 252,
  avg_speed: 64,
  avg_road_quality: 4.6,
};

describe("RecentRidesTable", () => {
  it("renders a row with distance, formatted duration, avg speed and quality", () => {
    render(<RecentRidesTable rides={[ride]} />);
    expect(screen.getByText("Stelvio Loop")).toBeInTheDocument();
    expect(screen.getByText("186")).toBeInTheDocument();
    expect(screen.getByText("4h 12m")).toBeInTheDocument();
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByLabelText(/Quality 5 of 5/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @tarmoto/companion test -- RecentRidesTable`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// apps/companion/src/app/(dashboard)/_home/RecentRidesTable.tsx
"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, Mono, QualityBars } from "@tarmoto/ui";
import type { UserRide } from "@/hooks/useUserRides";

/** Backend `avg_road_quality` is already a 0–5 scale; round into a tier. */
function qualityTier(q: number | null): 1 | 2 | 3 | 4 | 5 | null {
  if (q == null) return null;
  return Math.min(5, Math.max(1, Math.round(q))) as 1 | 2 | 3 | 4 | 5;
}

/** "4h 12m" / "52m" from whole minutes. */
function formatDuration(min: number | null): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDay(iso: string): string {
  // "18 Apr" — locale-stable day + short month.
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

const COLS = "grid grid-cols-[90px_1fr_80px_90px_70px_90px_40px] items-center";

export function RecentRidesTable({ rides }: { rides: UserRide[] }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div
        className={`${COLS} border-b border-line bg-paper px-5 py-3 font-mono text-[10px] uppercase tracking-[1.2px] text-fg-mute`}
      >
        <span>DATE</span>
        <span>RIDE</span>
        <span>KM</span>
        <span>DURATION</span>
        <span>AVG</span>
        <span>QUALITY</span>
        <span />
      </div>
      {rides.map((ride, i) => {
        const tier = qualityTier(ride.avg_road_quality);
        return (
          <Link
            key={ride.id}
            href={`/rides/${ride.id}`}
            className={`${COLS} px-5 py-3.5 text-[13px] transition hover:bg-paper ${
              i < rides.length - 1 ? "border-b border-line" : ""
            }`}
          >
            <Mono className="text-fg-dim">{formatDay(ride.started_at)}</Mono>
            <span className="truncate font-bold text-ink">
              {ride.name ?? formatDay(ride.started_at)}
            </span>
            <Mono className="font-bold text-ink">
              {ride.distance_km != null ? Math.round(ride.distance_km) : "—"}
            </Mono>
            <Mono className="text-fg-dim">
              {formatDuration(ride.duration_min)}
            </Mono>
            <Mono className="text-ink">
              {ride.avg_speed != null ? Math.round(ride.avg_speed) : "—"}
            </Mono>
            <span>
              {tier != null ? (
                <QualityBars q={tier} size={4} />
              ) : (
                <span className="text-fg-mute">—</span>
              )}
            </span>
            <ArrowRight size={14} className="justify-self-end text-fg-mute" />
          </Link>
        );
      })}
    </Card>
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter @tarmoto/companion test -- RecentRidesTable`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/_home/RecentRidesTable.tsx" "apps/companion/src/app/(dashboard)/_home/RecentRidesTable.test.tsx"
git commit -m "feat(companion): add RecentRidesTable matching the home design"
```

### Task A3: Wire the table into the home page

**Files:**

- Modify: `apps/companion/src/app/(dashboard)/page.tsx`

- [ ] **Step 1: Import the hook + table, and fetch rides**

Add to the imports at the top of `page.tsx`:

```tsx
import { useRecentRides } from "@/hooks/useRecentRides";
import { RecentRidesTable } from "./_home/RecentRidesTable";
```

In `HomePage()`, just below the `useUserTrips()` line (`page.tsx:64`):

```tsx
const { rides: recentRides, loading: ridesLoading } = useRecentRides(5);
```

- [ ] **Step 2: Fold rides into the "returning rider" gate**

The page currently treats only trips as content (`page.tsx:83`). A rider with rides but no trips is still a returning rider. Replace `page.tsx:83`:

```tsx
const hasAnyContent = trips.length > 0 || recentRides.length > 0;
```

And widen the loading guard at `page.tsx:91` so the first-time hero doesn't flash before rides resolve:

```tsx
const isFirstTimeUser =
  !loading && !ridesLoading && !tripsError && !hasAnyContent;
```

- [ ] **Step 3: Render the table in the returning-rider branch**

In the returning-rider branch, replace the empty "Recent rides" `Card` block (`page.tsx:211-226`) with a conditional: table when there are rides, the existing empty card otherwise. New block:

```tsx
{
  recentRides.length > 0 ? (
    <RecentRidesTable rides={recentRides} />
  ) : (
    <Card padded={false} className="px-6 py-10 text-center">
      <History size={18} strokeWidth={2} className="mx-auto text-fg-mute" />
      <Stamp className="mt-2.5 block">{t("Recent rides")}</Stamp>
      <p className="mt-1 text-[16px] font-bold text-ink">
        {t("No rides recorded yet")}
      </p>
      <p className="mx-auto mt-1 max-w-[320px] text-[12px] leading-[1.55] text-fg-dim">
        {t(
          "Your rides from the mobile app will appear here once you start tracking.",
        )}
      </p>
    </Card>
  );
}
```

- [ ] **Step 4: Typecheck + run the home page test (if present) + lint**

Run: `pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/page.tsx"
git commit -m "feat(companion): show RecentRidesTable on the home returning-rider view"
```

---

## Slice B — Monthly KPI tiles + mobile-sync pill (new backend endpoint)

### Task B1: Shared `MonthlyStats` wire type

**Files:**

- Create: `packages/shared/src/monthly-stats.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/monthly-stats.test.ts` (only if the package has a test dir; otherwise skip the test and rely on the backend `implements` check)

- [ ] **Step 1: Create the type**

```ts
// packages/shared/src/monthly-stats.ts
/**
 * Wire shape for `GET /users/me/stats/monthly` — the companion home
 * screen's four KPI tiles plus the mobile-sync pill.
 *
 * All figures are metric and scoped to the current calendar month (UTC),
 * with the previous month's totals included so the client can render
 * deltas ("+18% vs last month") in the rider's locale rather than the
 * server baking English strings. Backend `MonthlyStatsDto` implements
 * this interface; the companion consumes it via the generated client.
 */
export interface MonthlyStats {
  /** Sum of `distance_km` over completed rides started this month. */
  this_month_km: number;
  /** Same, for the previous calendar month (delta baseline). */
  prev_month_km: number;
  /** Ride time (hours) over completed rides this month. */
  ride_hours: number;
  /** Ride time (hours) the previous calendar month. */
  prev_ride_hours: number;
  /** Distinct road segments ridden this month. */
  new_roads: number;
  /** Max lean angle (deg) recorded this month, or null if none. */
  max_lean_deg: number | null;
  /** Name (or null) of the ride that set this month's max lean. */
  max_lean_ride_name: string | null;
  /** ISO start timestamp of that ride, or null. */
  max_lean_at: string | null;
  /** Most recent mobile upload (latest ride row), or null if never synced. */
  last_synced_at: string | null;
}
```

- [ ] **Step 2: Export it** — add to `packages/shared/src/index.ts` in alphabetical position (after `./me-profile`):

```ts
export * from "./monthly-stats";
```

- [ ] **Step 3: Build the shared package**

Run: `pnpm --filter @tarmoto/shared build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/monthly-stats.ts packages/shared/src/index.ts
git commit -m "feat(shared): add MonthlyStats wire type for the home KPI tiles"
```

### Task B2: `MonthlyStatsDto` + service aggregation + route

**Files:**

- Create: `apps/backend/src/modules/users/dto/monthly-stats.dto.ts`
- Modify: `apps/backend/src/modules/users/users.service.ts`
- Modify: `apps/backend/src/modules/users/users.controller.ts`
- Modify (test): `apps/backend/src/modules/users/users.service.spec.ts`

- [ ] **Step 1: Create the DTO**

```ts
// apps/backend/src/modules/users/dto/monthly-stats.dto.ts
import { ApiProperty } from "@nestjs/swagger";
import type { MonthlyStats } from "@tarmoto/shared";

/**
 * `GET /users/me/stats/monthly` response. `implements MonthlyStats` locks
 * the field set to the canonical `@tarmoto/shared` interface so any drift
 * is a compile error, mirroring `MeProfileDto`.
 */
export class MonthlyStatsDto implements MonthlyStats {
  @ApiProperty({
    description: "Distance (km) over completed rides this month.",
  })
  this_month_km!: number;

  @ApiProperty({ description: "Distance (km) the previous calendar month." })
  prev_month_km!: number;

  @ApiProperty({ description: "Ride time (hours) this month." })
  ride_hours!: number;

  @ApiProperty({
    description: "Ride time (hours) the previous calendar month.",
  })
  prev_ride_hours!: number;

  @ApiProperty({ description: "Distinct road segments ridden this month." })
  new_roads!: number;

  @ApiProperty({
    nullable: true,
    description: "Max lean angle (deg) this month.",
  })
  max_lean_deg!: number | null;

  @ApiProperty({ nullable: true, description: "Ride that set the max lean." })
  max_lean_ride_name!: string | null;

  @ApiProperty({ nullable: true, description: "ISO start of that ride." })
  max_lean_at!: string | null;

  @ApiProperty({
    nullable: true,
    description: "Latest mobile upload, or null.",
  })
  last_synced_at!: string | null;
}
```

- [ ] **Step 2: Write the failing service test**

Append to `apps/backend/src/modules/users/users.service.spec.ts` a case for `getMonthlyStats`. Match the existing harness in that file (it already builds `UsersService` with mocked repos — reuse those mocks; add a `ride_segments` raw-query expectation via the `rideRepo` query builder mock). Skeleton:

```ts
describe("getMonthlyStats", () => {
  it("returns current + previous month aggregates and the max-lean ride", async () => {
    // Arrange: rideRepo.createQueryBuilder(...).getRawMany() resolves two
    // month rows; a second builder resolves the max-lean row; a third
    // resolves the distinct new-roads count; a fourth resolves last sync.
    // (Follow the existing getMeProfile test's queryBuilder mock style.)
    const result = await service.getMonthlyStats("user-1");
    expect(result.this_month_km).toBe(1284);
    expect(result.prev_month_km).toBe(1088);
    expect(result.max_lean_deg).toBe(41);
    expect(result.max_lean_ride_name).toBe("Passo Gavia");
    expect(result.last_synced_at).toBe("2026-06-03T09:00:00.000Z");
  });
});
```

> Read `users.service.spec.ts` first and mirror its exact `createQueryBuilder` mock shape — do not invent a new mocking style. If the file mocks repos as plain objects, give `createQueryBuilder` a `vi.fn()`/`jest.fn()` returning a chainable stub whose terminal (`getRawMany`/`getRawOne`) resolves the fixture rows in call order.

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- users.service`
Expected: FAIL — `getMonthlyStats is not a function`.

- [ ] **Step 4: Implement `getMonthlyStats`**

Add to `UsersService` (it already injects `rideRepo`; add `RideStats` + `RideSegment` repos to the constructor via `@InjectRepository`, importing the entities from `../../entities/...`). Method:

```ts
/**
 * Current-calendar-month KPI snapshot for the home screen (UTC month
 * boundaries via `date_trunc` so it agrees with the stored timestamptz).
 * Distance/hours are summed over completed rides; `new_roads` counts the
 * distinct road segments ridden this month; max lean comes from this
 * month's `ride_stats`; `last_synced_at` is the newest ride row (any
 * status) as a proxy for the last mobile upload.
 */
async getMonthlyStats(userId: string): Promise<MonthlyStatsDto> {
  const [months, leanRow, roadsRow, syncRow] = await Promise.all([
    // Distance + hours for this month and last month, grouped.
    this.rideRepo
      .createQueryBuilder('r')
      .select("date_trunc('month', r.started_at)", 'month')
      .addSelect('COALESCE(SUM(r.distance_km), 0)', 'km')
      .addSelect(
        "COALESCE(SUM(EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) / 3600.0), 0)",
        'hours',
      )
      .where('r.user_id = :userId', { userId })
      .andWhere("r.status = 'completed'")
      .andWhere('r.ended_at IS NOT NULL')
      .andWhere(
        "r.started_at >= date_trunc('month', now()) - interval '1 month'",
      )
      .groupBy("date_trunc('month', r.started_at)")
      .getRawMany<{ month: string; km: string; hours: string }>(),
    // Max lean angle this month + the ride that set it.
    this.rideRepo
      .createQueryBuilder('r')
      .innerJoin('ride_stats', 's', 's.ride_id = r.id')
      .select('s.max_lean_angle', 'lean')
      .addSelect('r.name', 'name')
      .addSelect('r.started_at', 'started_at')
      .where('r.user_id = :userId', { userId })
      .andWhere("r.started_at >= date_trunc('month', now())")
      .andWhere('s.max_lean_angle IS NOT NULL')
      .orderBy('s.max_lean_angle', 'DESC')
      .limit(1)
      .getRawOne<{ lean: number; name: string | null; started_at: Date }>(),
    // Distinct road segments ridden this month.
    this.rideRepo
      .createQueryBuilder('r')
      .innerJoin('ride_segments', 'seg', 'seg.ride_id = r.id')
      .select('COUNT(DISTINCT seg.road_segment_id)', 'roads')
      .where('r.user_id = :userId', { userId })
      .andWhere("r.started_at >= date_trunc('month', now())")
      .andWhere('seg.road_segment_id IS NOT NULL')
      .getRawOne<{ roads: string }>(),
    // Last mobile upload proxy = newest ride row.
    this.rideRepo
      .createQueryBuilder('r')
      .select('MAX(r.created_at)', 'synced')
      .where('r.user_id = :userId', { userId })
      .getRawOne<{ synced: Date | null }>(),
  ]);

  const monthStart = startOfUtcMonth(new Date());
  const isThisMonth = (m: string) =>
    new Date(m).getUTCMonth() === monthStart.getUTCMonth() &&
    new Date(m).getUTCFullYear() === monthStart.getUTCFullYear();

  const cur = months.find((m) => isThisMonth(m.month));
  const prev = months.find((m) => !isThisMonth(m.month));

  return {
    this_month_km: Math.round(parseFloat(cur?.km ?? '0')),
    prev_month_km: Math.round(parseFloat(prev?.km ?? '0')),
    ride_hours: Math.round(parseFloat(cur?.hours ?? '0')),
    prev_ride_hours: Math.round(parseFloat(prev?.hours ?? '0')),
    new_roads: parseInt(roadsRow?.roads ?? '0', 10),
    max_lean_deg: leanRow ? Math.round(leanRow.lean) : null,
    max_lean_ride_name: leanRow?.name ?? null,
    max_lean_at: leanRow ? new Date(leanRow.started_at).toISOString() : null,
    last_synced_at: syncRow?.synced
      ? new Date(syncRow.synced).toISOString()
      : null,
  };
}
```

Add this private helper near the bottom of the service:

```ts
/** First instant of the current UTC calendar month. */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
```

> Verify the join table/column names against the entities before running: confirm `ride_stats.max_lean_angle` (`apps/backend/src/entities/ride-stats.entity.ts`) and the ride-segment table name + `road_segment_id` column (`apps/backend/src/entities/ride-segment.entity.ts`). Fix the raw join strings if they differ. Add `import type { MonthlyStats } ...` is not needed in the service (the DTO carries it); just `import { MonthlyStatsDto } from './dto/monthly-stats.dto.js';`.

- [ ] **Step 5: Add the controller route**

In `users.controller.ts`, import the DTO and add a route immediately after `getMeProfile` (`:92`). Declare it before `:userId/profile` so the literal `me` segment wins:

```ts
  @Get('me/stats/monthly')
  @ApiOperation({
    summary: "Current month's KPI snapshot for the home dashboard",
    description:
      'Distance, ride time, distinct roads, and max lean for the current ' +
      'calendar month (with the previous month for deltas), plus the last ' +
      'mobile-sync timestamp. Drives the companion home KPI tiles + pill.',
  })
  @ApiResponse({ status: 200, type: MonthlyStatsDto })
  async getMonthlyStats(
    @Req() req: express.Request,
  ): Promise<MonthlyStatsDto> {
    return this.usersService.getMonthlyStats(req.user!.userId);
  }
```

- [ ] **Step 6: Run the service test + verify it passes**

Run: `pnpm --filter @tarmoto/backend test -- users.service`
Expected: PASS.

- [ ] **Step 7: Build the backend (catches DI/entity-registration errors)**

Run: `pnpm --filter @tarmoto/backend build`
Expected: success. If a new repo injection fails at runtime later, confirm `RideStats`/`RideSegment` are registered in the users module's `TypeOrmModule.forFeature([...])`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/modules/users/dto/monthly-stats.dto.ts apps/backend/src/modules/users/users.service.ts apps/backend/src/modules/users/users.controller.ts apps/backend/src/modules/users/users.service.spec.ts
git commit -m "feat(backend): add GET /users/me/stats/monthly KPI endpoint"
```

### Task B3: Regenerate OpenAPI + client

**Files:**

- Modify (generated): `packages/openapi/openapi.yaml`, `packages/openapi-client/src/generated/schema.d.ts`

- [ ] **Step 1: Regenerate**

Run: `pnpm openapi:gen`
Expected: `==> Done!`; `packages/openapi/openapi.yaml` now contains `/users/me/stats/monthly` and the `MonthlyStatsDto` schema; `schema.d.ts` regenerates.

- [ ] **Step 2: Sanity-check the path landed**

Run: `grep -c "me/stats/monthly" packages/openapi/openapi.yaml`
Expected: ≥ 1.

- [ ] **Step 3: Commit the regenerated artifacts**

```bash
git add packages/openapi/openapi.yaml packages/openapi-client/src/generated/schema.d.ts
git commit -m "chore(openapi): regenerate for monthly stats endpoint"
```

### Task B4: `useMonthlyStats` hook + page wiring (KPI tiles + sync pill)

**Files:**

- Create: `apps/companion/src/hooks/useMonthlyStats.ts`
- Modify: `apps/companion/src/app/(dashboard)/page.tsx`

- [ ] **Step 1: Implement the hook**

```ts
// apps/companion/src/hooks/useMonthlyStats.ts
import { useQuery } from "@tanstack/react-query";
import type { MonthlyStats } from "@tarmoto/shared";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

/**
 * Current-month KPI snapshot for the home tiles + sync pill. Returns
 * `null` while loading or if the user has no rides yet (the endpoint
 * still 200s with zeros / nulls — the page hides the tile row when the
 * month is empty so we don't show a wall of zeros to a returning rider
 * who simply hasn't ridden this month).
 */
export function useMonthlyStats(): {
  stats: MonthlyStats | null;
  loading: boolean;
} {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const query = useQuery({
    queryKey: ["monthly-stats", userId],
    enabled: userId != null,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/api/v1/users/me/stats/monthly", {
        signal,
      });
      if (error) throw new Error("monthly stats fetch failed");
      return data as unknown as MonthlyStats;
    },
  });

  return { stats: query.data ?? null, loading: query.isLoading };
}
```

> Confirm the path prefix: existing companion calls use `"/api/v1/..."` (e.g. `useUserRides` calls `"/api/v1/rides"`). Match that exactly — the generated `paths` key must include the `/api/v1` base.

- [ ] **Step 2: Replace the hardcoded nulls + map to the tile props**

In `page.tsx`, delete the `const monthlyStats: MonthlyStats | null = null;` and `const mobileSync: MobileSyncStatus | null = null;` stubs (`:73`, `:77`) and the now-unused `MonthlyStats`/`MobileSyncStatus` local interfaces (`:273-286`). Import + call the hook:

```tsx
import { useMonthlyStats } from "@/hooks/useMonthlyStats";
// ...inside HomePage():
const { stats: monthlyStats } = useMonthlyStats();
```

- [ ] **Step 3: Rework `KpiTileRow` to consume the wire shape**

The existing `KpiTileRow` (`page.tsx:324`) reads `thisMonthKm`, `vsLastMonthKm`, etc. Update its signature to take `MonthlyStats` and format deltas inline. Replace the component body:

```tsx
import type { MonthlyStats } from "@tarmoto/shared";

function KpiTileRow({ stats }: { stats: MonthlyStats }) {
  const kmDelta =
    stats.prev_month_km > 0
      ? `${stats.this_month_km >= stats.prev_month_km ? "+" : ""}${Math.round(
          ((stats.this_month_km - stats.prev_month_km) / stats.prev_month_km) *
            100,
        )}% ${t("vs last month")}`
      : t("first tracked month");
  const hoursDelta = `${stats.ride_hours >= stats.prev_ride_hours ? "+" : ""}${
    stats.ride_hours - stats.prev_ride_hours
  }h ${t("vs last month")}`;
  const leanSub =
    stats.max_lean_ride_name && stats.max_lean_at
      ? `${stats.max_lean_ride_name} · ${new Date(
          stats.max_lean_at,
        ).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`
      : t("No lean recorded");

  return (
    <div className="mb-8 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
      <KpiTile
        label={t("This month")}
        value={stats.this_month_km.toLocaleString()}
        unit="KM"
        delta={kmDelta}
        ink
        accentValue
      />
      <KpiTile
        label={t("Ride time")}
        value={String(stats.ride_hours)}
        unit="HRS"
        delta={hoursDelta}
      />
      <KpiTile
        label={t("New roads")}
        value={String(stats.new_roads)}
        unit="DISCOVERED"
        delta={t("this month")}
      />
      <KpiTile
        label={t("Lean angle")}
        value={stats.max_lean_deg != null ? `${stats.max_lean_deg}°` : "—"}
        unit="MAX"
        delta={leanSub}
        accentValue
      />
    </div>
  );
}
```

- [ ] **Step 4: Gate the tile row on a non-empty month**

The current render gate (`page.tsx:116`) is `{monthlyStats && <KpiTileRow .../>}`. Tighten it so an all-zero month (returning rider who hasn't ridden) doesn't show four zeros:

```tsx
{
  monthlyStats && monthlyStats.this_month_km > 0 && (
    <KpiTileRow stats={monthlyStats} />
  );
}
```

- [ ] **Step 5: Drive the sync pill from `last_synced_at`**

Change `<SyncPill status={mobileSync} />` (`page.tsx:112`) to pass the timestamp, and simplify `SyncPill` (`page.tsx:288`) to take `syncedAt: string | null`:

```tsx
<SyncPill syncedAt={monthlyStats?.last_synced_at ?? null} />
```

```tsx
function SyncPill({ syncedAt }: { syncedAt: string | null }) {
  if (!syncedAt) {
    return (
      <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] text-fg-dim">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-mute" />
        {t("No mobile sync yet")}
      </div>
    );
  }
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent px-2.5 py-[5px] text-[11px] font-bold tracking-[0.2px] text-ink">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
      {formatSyncedLabel(new Date(syncedAt))}
    </div>
  );
}
```

`formatSyncedLabel` (`page.tsx:315`) stays as-is (it already takes a `Date`). Delete the now-unused `MobileSyncStatus` interface.

- [ ] **Step 6: Typecheck + lint + test**

Run: `pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion lint && pnpm --filter @tarmoto/companion test -- page`
Expected: clean. Fix any `t()` catalog-key additions the i18n lint flags (add the new keys — `"vs last month"`, `"first tracked month"`, `"this month"`, `"No lean recorded"` — to the catalog the way existing keys are registered; check how `t()` keys are declared by grepping an existing key like `"Know the road before you ride it."`).

- [ ] **Step 7: Commit**

```bash
git add apps/companion/src/hooks/useMonthlyStats.ts "apps/companion/src/app/(dashboard)/page.tsx"
git commit -m "feat(companion): wire home KPI tiles + sync pill to monthly stats"
```

---

## Slice C — Enriched trip-draft cards (distance / quality / passes)

### Task C1: Extend `TripSummaryDto` + service aggregation

**Files:**

- Modify: `apps/backend/src/modules/trips/dto/trip-response.dto.ts`
- Modify: `apps/backend/src/modules/trips/trips.service.ts`
- Modify (test): `apps/backend/src/modules/trips/trips.service.spec.ts`

- [ ] **Step 1: Add the three fields to `TripSummaryDto`**

Append to `TripSummaryDto` (after `created_at`, `trip-response.dto.ts:68`):

```ts
  @ApiProperty({
    nullable: true,
    description:
      'Total planned distance (km) = SUM of the trip days’ `distance_km`. ' +
      '`null` when no day has a recorded distance.',
  })
  distance_km!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Distance-weighted average road quality (0–5) across the trip days. ' +
      '`null` when no day has a recorded quality.',
  })
  quality_avg!: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Count of mountain passes within 2 km of any of the trip’s day ' +
      'geometries. `0` for trips with no nearby passes; `null` when the ' +
      'trip has no day geometry to test against.',
  })
  passes_count!: number | null;
```

- [ ] **Step 2: Write the failing service test**

In `trips.service.spec.ts`, add a `list` case asserting the new fields are hydrated. Mirror the file's existing repo-mock style; the new aggregate query should be mocked to return one row per trip. Skeleton:

```ts
it("hydrates distance_km, quality_avg and passes_count on the summary", async () => {
  // Arrange the list query to return one trip, and the aggregate query
  // (getRawMany) to return { trip_id, distance_km: 610, quality_avg: 4.4,
  //   passes_count: 6 } for it.
  const trips = await service.list("user-1", {} as never);
  expect(trips[0].distance_km).toBe(610);
  expect(trips[0].quality_avg).toBeCloseTo(4.4);
  expect(trips[0].passes_count).toBe(6);
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @tarmoto/backend test -- trips.service`
Expected: FAIL — fields `undefined`.

- [ ] **Step 4: Implement aggregation in `list()` and update `toSummary`**

Update `toSummary` (`trips.service.ts:970`) to accept optional aggregates and default them to `null`:

```ts
  private toSummary(
    trip: Trip,
    agg?: { distance_km: number | null; quality_avg: number | null; passes_count: number | null },
  ): TripSummaryDto {
    return {
      id: trip.id,
      owner_id: trip.owner_id,
      title: trip.title,
      region: trip.region,
      num_days: trip.num_days,
      status: trip.status as TripStatus,
      member_count: trip.member_count ?? trip.members?.length ?? 0,
      folder_id: trip.folder_id ?? null,
      created_at: trip.created_at.toISOString(),
      distance_km: agg?.distance_km ?? null,
      quality_avg: agg?.quality_avg ?? null,
      passes_count: agg?.passes_count ?? null,
    };
  }
```

In `list()` (`trips.service.ts:856`), after `const trips = await qb.getMany();`, compute aggregates for the returned ids in one query and merge:

```ts
const trips = await qb.getMany();
if (trips.length === 0) return [];

const ids = trips.map((t) => t.id);

// One pass over trip_days for distance + distance-weighted quality, and
// a spatial count of nearby passes, grouped by trip. Kept to a single
// round trip over the page of trips the caller can see (their own), so
// no N+1 even for a rider with many trips.
const aggRows = await this.tripDayRepo
  .createQueryBuilder("d")
  .select("d.trip_id", "trip_id")
  .addSelect("SUM(d.distance_km)", "distance_km")
  .addSelect(
    "CASE WHEN SUM(d.distance_km) > 0 " +
      "THEN SUM(d.avg_quality * d.distance_km) / SUM(d.distance_km) " +
      "ELSE AVG(d.avg_quality) END",
    "quality_avg",
  )
  .addSelect(
    "(SELECT COUNT(DISTINCT mp.id) FROM mountain_passes mp " +
      "WHERE EXISTS (SELECT 1 FROM trip_days td WHERE td.trip_id = d.trip_id " +
      "AND td.route_geom IS NOT NULL " +
      "AND ST_DWithin(mp.location::geography, td.route_geom::geography, 2000)))",
    "passes_count",
  )
  .where("d.trip_id IN (:...ids)", { ids })
  .groupBy("d.trip_id")
  .getRawMany<{
    trip_id: string;
    distance_km: string | null;
    quality_avg: string | null;
    passes_count: string | null;
  }>();

const aggById = new Map(
  aggRows.map((r) => [
    r.trip_id,
    {
      distance_km: r.distance_km != null ? parseFloat(r.distance_km) : null,
      quality_avg: r.quality_avg != null ? parseFloat(r.quality_avg) : null,
      passes_count:
        r.passes_count != null ? parseInt(r.passes_count, 10) : null,
    },
  ]),
);

return trips.map((t) => this.toSummary(t, aggById.get(t.id)));
```

Add a `TripDay` repository to the constructor if not present (`@InjectRepository(TripDay) private readonly tripDayRepo: Repository<TripDay>`), importing `TripDay` from `../../entities/trip-day.entity.js`, and register `TripDay` in the trips module's `forFeature` if it isn't already.

> Verify `trip_days.route_geom` is the actual column name (`trip-day.entity.ts` — the day route lives there; confirm the `@Column` name). If the geometry column is named differently, fix the `ST_DWithin` subquery. `member_count` hydration via `loadRelationCountAndMap` is unaffected.

- [ ] **Step 5: Run the test + verify it passes; build**

Run: `pnpm --filter @tarmoto/backend test -- trips.service && pnpm --filter @tarmoto/backend build`
Expected: PASS + build success.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/modules/trips/dto/trip-response.dto.ts apps/backend/src/modules/trips/trips.service.ts apps/backend/src/modules/trips/trips.service.spec.ts
git commit -m "feat(backend): enrich trip summary with distance, quality and passes"
```

### Task C2: Regenerate OpenAPI + client

- [ ] **Step 1: Regenerate + sanity-check**

Run: `pnpm openapi:gen && grep -c "passes_count" packages/openapi/openapi.yaml`
Expected: `==> Done!` and count ≥ 1.

- [ ] **Step 2: Commit**

```bash
git add packages/openapi/openapi.yaml packages/openapi-client/src/generated/schema.d.ts
git commit -m "chore(openapi): regenerate for enriched trip summary"
```

### Task C3: Carry new fields through the companion trip type + card

**Files:**

- Modify: `apps/companion/src/lib/types.ts` (`TripSummary`)
- Modify: `apps/companion/src/lib/trip-from-detail.ts` (`tripSummaryFromWire` + `TripSummaryWire`)
- Modify: `apps/companion/src/app/(dashboard)/page.tsx` (`TripDraftCard`)

- [ ] **Step 1: Confirm the companion `TripSummary` already declares the optional fields**

`types.ts` already has `distance_km?`, `passes_count?`, `quality_avg?` as optional (per the file header TODO). If they are missing, add them as `number | null`. Then map them in `tripSummaryFromWire` (`trip-from-detail.ts`):

```ts
    distance_km: wire.distance_km ?? null,
    quality_avg: wire.quality_avg ?? null,
    passes_count: wire.passes_count ?? null,
```

and add the same three keys (`number | null`) to the `TripSummaryWire` type in that file.

- [ ] **Step 2: Light up the card slots**

Replace `TripDraftCard` (`page.tsx:520`) so it consumes the real fields: render `QualityBars` from `quality_avg`, the `MiniRouteSvg` tier from `quality_avg`, and the KM / DAYS / PASSES meta. New body:

```tsx
import {
  Card,
  Heading,
  MiniRouteSvg,
  Mono,
  QualityBars,
  Stamp,
} from "@tarmoto/ui";
// ...

function tripTier(q: number | null | undefined): 1 | 2 | 3 | 4 | 5 {
  if (q == null) return 3;
  return Math.min(5, Math.max(1, Math.round(q))) as 1 | 2 | 3 | 4 | 5;
}

function TripDraftCard({
  trip,
  seed,
}: {
  trip: {
    id: string;
    name: string;
    status: string;
    num_days: number;
    distance_km?: number | null;
    quality_avg?: number | null;
    passes_count?: number | null;
  };
  seed: number;
}) {
  const status =
    (trip.status as "draft" | "planned" | "active" | "completed") ?? "draft";
  const tier = tripTier(trip.quality_avg);
  return (
    <Link
      href={`/trips/${trip.id}`}
      className="block overflow-hidden rounded-[14px] border border-line bg-cream transition hover:border-line-strong"
    >
      <div className="h-[120px]">
        <MiniRouteSvg q={tier} seed={seed} />
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Stamp tone={STATUS_TONE[status]}>{status}</Stamp>
            <div className="mt-1 line-clamp-2 text-[16px] font-extrabold leading-tight text-ink">
              {trip.name}
            </div>
          </div>
          <QualityBars q={tier} size={4} />
        </div>
        <div className="mt-2.5 flex items-center gap-3 text-[11px] text-fg-dim">
          {trip.distance_km != null && trip.distance_km > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">
                {Math.round(trip.distance_km)}
              </span>{" "}
              {t("KM")}
            </Mono>
          )}
          {trip.num_days > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">{trip.num_days}</span>{" "}
              {trip.num_days === 1 ? t("DAY") : t("DAYS")}
            </Mono>
          )}
          {trip.passes_count != null && trip.passes_count > 0 && (
            <Mono className="uppercase">
              <span className="font-bold text-ink">{trip.passes_count}</span>{" "}
              {trip.passes_count === 1 ? t("PASS") : t("PASSES")}
            </Mono>
          )}
        </div>
      </div>
    </Link>
  );
}
```

Ensure `QualityBars` is added to the `@tarmoto/ui` import line at the top of `page.tsx` (`:14`).

- [ ] **Step 3: Typecheck + lint + test**

Run: `pnpm --filter @tarmoto/companion typecheck && pnpm --filter @tarmoto/companion lint`
Expected: clean. Register any new `t()` keys (`"KM"`, `"DAY"`, `"DAYS"`, `"PASS"`, `"PASSES"`) if the i18n lint requires it.

- [ ] **Step 4: Commit**

```bash
git add "apps/companion/src/app/(dashboard)/page.tsx" apps/companion/src/lib/types.ts apps/companion/src/lib/trip-from-detail.ts
git commit -m "feat(companion): show distance, quality and passes on trip-draft cards"
```

---

## Final verification (whole feature, real data)

### Task V1: Boot the stack with seeded data and eyeball both states

- [ ] **Step 1: Start infra + migrate + seed**

Run:

```bash
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

Expected: seed prints accounts incl. `road.hunter@tarmoto.app` (power user with rides) and `trip.planner@tarmoto.app` (multi-day trips). Note the seeded password (grep `seed-demo-data.ts` for the demo password constant).

- [ ] **Step 2: Run backend + companion**

Run: `pnpm backend:dev` (port 3000) and `pnpm companion:dev` (port 3002) in two shells.

- [ ] **Step 3: Verify the populated state**

Log in as `road.hunter@tarmoto.app`. Confirm on `/`:

- KPI tile row renders (This month KM / Ride time / New roads / Lean angle) with real numbers and a `Passo Gavia`-style lean sublabel.
- Sync pill shows "Mobile synced …" (accent), not "No mobile sync yet".
- "Recent rides" renders the table (DATE / RIDE / KM / DURATION / AVG / QUALITY bars), newest first.
- "Trip drafts" cards show KM / DAYS / PASSES + quality bars (log in as `trip.planner@tarmoto.app` if road.hunter has no drafts).

- [ ] **Step 4: Verify the empty state**

Log in as `newbie@tarmoto.app` (fresh, no rides/trips). Confirm `/` shows: "Welcome to Tarmoto", "No mobile sync yet" pill, no KPI tiles, and the dual empty cards ("No rides recorded yet" / "No trips planned yet" + Plan a trip CTA) — matching the empty design.

- [ ] **Step 5: Full gate before PR**

Run: `pnpm --filter @tarmoto/backend test && pnpm --filter @tarmoto/companion test && pnpm lint && pnpm --filter @tarmoto/backend build && pnpm --filter @tarmoto/companion build`
Expected: all green. Record anything not run.

- [ ] **Step 6: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR (`feat(companion): wire home screen populated state to real backend data`), linking the relevant issue, noting the new endpoint + enriched trip DTO as contract changes, and listing the verification evidence from Step 3/4.

---

## Self-review notes

- **Spec coverage:** KPI tiles (B), recent-rides table (A), sync pill (B), enriched trip cards (C), empty state (already correct; V1 Step 4 regression-checks it). The design's per-ride ⚠ hazard badge is intentionally out of scope (no backing data — decision #2).
- **Type consistency:** `MonthlyStats` field names (`this_month_km`, `prev_month_km`, `ride_hours`, `prev_ride_hours`, `new_roads`, `max_lean_deg`, `max_lean_ride_name`, `max_lean_at`, `last_synced_at`) are identical across the shared type, the DTO, the service return, and the hook/page consumer. `TripSummary` additions (`distance_km`, `quality_avg`, `passes_count`) match across DTO, wire type, mapper, and card. `qualityTier`/`tripTier` both use `round`-into-1–5 consistent with `avg_road_quality`'s 0–5 scale.
- **Open verifications flagged inline** (do not skip): ride-segment table/column names (B2 Step 4), `trip_days.route_geom` column name (C1 Step 4), `ListRidesDto` accepting `sort=started_at` (A1), the `/api/v1` path prefix in generated `paths` (A1/B4), and the seed demo password (V1 Step 1).

```

```
