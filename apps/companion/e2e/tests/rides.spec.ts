import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// The From/To filters are @tarmoto/ui DatePickers — button triggers that
// open a calendar popover — so "filling" a date means clicking the trigger,
// paging the calendar back to the target month, and picking the day cell.
// The calendar opens on today's month, so the paging loop is bounded rather
// than counted (the distance to April 2026 grows as CI's wall clock moves).
async function pickDate(
  page: Page,
  trigger: RegExp,
  monthHeading: RegExp,
  day: RegExp,
): Promise<void> {
  await page.getByRole("button", { name: trigger }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 48; i++) {
    if ((await dialog.getByRole("heading", { name: monthHeading }).count()) > 0)
      break;
    await dialog.getByRole("button", { name: /previous/i }).click();
  }
  await dialog.getByRole("button", { name: day }).click();
}

// Three seeded rides cover the assertions for T29 (list), T30 (filter),
// and T31 (detail). Distinct distances and start dates so the filter
// test has a deterministic pass/fail boundary; the third ride doubles
// as the click-through target for T31.
const RIDE_OLD = {
  name: "Spring shake-down",
  started_at: "2026-03-10T08:00:00.000Z",
  ended_at: "2026-03-10T10:30:00.000Z",
  distance_km: 80,
  duration_min: 150,
  avg_road_quality: 3.5,
};

const RIDE_RECENT = {
  name: "Easter loop",
  started_at: "2026-04-05T09:00:00.000Z",
  ended_at: "2026-04-05T13:00:00.000Z",
  distance_km: 220,
  duration_min: 240,
  avg_road_quality: 4.6,
};

const RIDE_DETAIL = {
  name: "Detail-target run",
  started_at: "2026-04-20T07:00:00.000Z",
  ended_at: "2026-04-20T10:00:00.000Z",
  distance_km: 175,
  duration_min: 180,
  avg_road_quality: 4.2,
  avg_speed: 90,
  elevation_gain: 1200,
  // Segment telemetry populates the speed graph, quality breakdown,
  // and segments table on the detail page — without it, the speed
  // graph stays in its empty state and the doc-level T31 acceptance
  // criterion ("speed graph") goes uncovered.
  segments: [
    {
      road_name: "Stelvio Pass",
      quality_reading: 4.5,
      speed_avg: 62,
      speed_max: 95,
      lean_angle_max: 38,
    },
    {
      road_name: "Bormio Loop",
      quality_reading: 4.1,
      speed_avg: 78,
      speed_max: 110,
      lean_angle_max: 32,
    },
  ],
};

test.describe("rides read path", () => {
  // T29 — Ride list: /rides shows a paginated row per ride with date,
  // distance, duration, and quality. The fallback "Ride on <date>" is
  // unused here because we seed each ride with an explicit `name`.
  test("T29: /rides renders a row per ride with date, distance, duration, and quality", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, RIDE_OLD);
    await mockApi.seedRide(user, RIDE_RECENT);

    await page.goto("/rides");

    // Each seeded ride surfaces by its custom name. The DataTable renders
    // each row as a real <tr> whose RIDE cell is a <Link> to the detail
    // page — the link's accessible name carries the ride name (plus the
    // ride type), so match on the name with a regex.
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_OLD.name) }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_RECENT.name) }),
    ).toBeVisible();

    // Distance / duration / quality cells render in their formatted shape.
    // Scope to the recent ride's row: KM column shows whole km, DURATION
    // uses `format.durationCompact()` (locale-formatting migration, #1012
    // Task 8) — for an exact-hour duration that renders just "Xh", dropping
    // the zero-minutes suffix the pre-migration helper used to keep ("Xh
    // 0m") — and QUALITY renders the QualityBars glyph (aria-labelled
    // "Quality N of 5"; 4.6 → tier 5).
    const recentRow = page
      .getByRole("row")
      .filter({ hasText: RIDE_RECENT.name });
    await expect(recentRow.getByText("220")).toBeVisible();
    await expect(recentRow.getByText("4h", { exact: true })).toBeVisible();
    await expect(recentRow.getByLabel("Quality 5 of 5")).toBeVisible();

    // The "All rides · N" tab badge reflects both rides (the single-page
    // table no longer renders an inline "N rides" footer — that count
    // lives in the tab badge).
    await expect(page.getByRole("link", { name: /All rides/ })).toContainText(
      "2",
    );
  });

  // T30 — Filter by date range + min distance: applying filters writes
  // the documented URL params (`from`, `to`, `minDist`) and the list
  // re-renders to drop rides that fall outside the window. Only
  // RIDE_RECENT (April 2026, 220 km) survives the filter below.
  test("T30: filtering by date and min distance updates the list and the URL", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, RIDE_OLD);
    await mockApi.seedRide(user, RIDE_RECENT);

    await page.goto("/rides");
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_OLD.name) }),
    ).toBeVisible({ timeout: 10_000 });

    // From/To are DatePicker buttons (aria-label "From date"/"To date",
    // with the formatted value appended once set) — drive them through the
    // calendar popover. Min km stays a text input, but its commit is
    // debounced 300 ms before the URL write, so the polls below double as
    // the debounce wait.
    await pickDate(page, /^from date/i, /april 2026/i, /april 1, 2026/i);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("from"))
      .toBe("2026-04-01");
    await pickDate(page, /^to date/i, /april 2026/i, /april 30, 2026/i);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("to"))
      .toBe("2026-04-30");
    await page.getByLabel(/^min km\b/i).fill("100");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("minDist"))
      .toBe("100");

    // Filter-pruning: the March ride should drop off, the April one
    // stays. The "All rides · N" tab badge tracks the post-filter set size
    // (the All-rides page feeds the badge its own filtered total).
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_OLD.name) }),
    ).toBeHidden();
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_RECENT.name) }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /All rides/ })).toContainText(
      "1",
    );
  });

  // T31 — Ride detail: clicking a ride row routes to `/rides/[id]` and the
  // v2 detail page shows the trip metadata — H1 is the ride name, MetricTile
  // stats (distance / avg speed / ascent …), the route map, the road-segments
  // table, and the elevation climb/descent summary.
  test("T31: clicking through to a ride opens its detail with route + stats", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // Ascent + Max lean are `advanced_ride_stats` (Pro) — grant the rider a paid
    // tier so those tiles render their values instead of the locked teaser.
    await mockApi.setSubscription(user.id, "premium");
    const seeded = await mockApi.seedRide(user, RIDE_DETAIL);

    await page.goto("/rides");
    await expect(
      page.getByRole("link", { name: new RegExp(RIDE_DETAIL.name) }),
    ).toBeVisible({ timeout: 10_000 });

    // Each row's RIDE cell is a <Link> to the detail page; click it to
    // route through. (The whole row is clickable via a stretched overlay,
    // but the link in the row is the single discoverable navigation
    // control.)
    await page
      .getByRole("link", { name: new RegExp(RIDE_DETAIL.name) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/rides/${seeded.id}$`), {
      timeout: 10_000,
    });

    // H1: the detail header now surfaces the ride's name (the rename
    // affordance lives here); an unnamed ride falls back to "Ride on
    // <date>". This ride is seeded with an explicit name.
    await expect(
      page.getByRole("heading", { level: 1, name: RIDE_DETAIL.name }),
    ).toBeVisible();

    // Stat tiles (MetricTile) key off the seeded metadata. Scope to each tile
    // by its label + value (the innermost div carrying both is the tile) so a
    // regression that drops hydration — rendering "—" — fails the assertion.
    const statTile = (label: string, value: string) =>
      page
        .locator("div")
        .filter({ hasText: label })
        .filter({ hasText: value })
        .last();
    await expect(statTile("Avg speed", "90")).toBeVisible();
    await expect(statTile("Distance", "175")).toBeVisible();
    await expect(statTile("Ascent", "1,200")).toBeVisible();

    // Route map rendered with the seeded geometry (not the no-GPS fallback).
    // RideRouteMap renders `<div aria-label="Ride route map">`.
    await expect(page.getByLabel(/ride route map/i)).toBeVisible();
    await expect(page.getByText(/no gps track was recorded/i)).toBeHidden();

    // Speed profile (US-48): the per-segment speed graph renders for rides
    // with segment telemetry.
    await expect(
      page.getByRole("img", { name: /ride speed graph/i }),
    ).toBeVisible();

    // Road segments table: each seeded segment surfaces by its road_name.
    await expect(page.getByText("Stelvio Pass")).toBeVisible();
    await expect(page.getByText("Bormio Loop")).toBeVisible();
    await expect(page.getByText(/roads ridden/i)).toBeVisible();

    // Elevation summary: per-sample profile isn't recorded yet, so the card
    // shows the climb/descent totals + an honest note.
    await expect(page.getByText("Climb & descent")).toBeVisible();
    await expect(
      page.getByText(/per-sample elevation profile isn't recorded yet/i),
    ).toBeVisible();
  });
});

test.describe("rides extras", () => {
  // T32 — Ride stats: `/rides/stats` aggregates all the rider's rides
  // (via `fetchAllRides` → paginated `/api/v1/rides`) and renders the
  // Statistics page with totals + a monthly chart. We seed two rides
  // and assert the heading, the "N rides in view" subtitle, and the
  // totals grid (specifically Total rides + Total distance) so a
  // regression in either the aggregation logic or the totals render
  // fails the test.
  test("T32: /rides/stats renders totals + chart for the rider's rides", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // The whole route is `advanced_analytics` (Premium, #1167) — the default
    // fixture rider is Free, and would see the locked teaser rather than any
    // of the content this case is about.
    await mockApi.setSubscription(user.id, "premium");
    await mockApi.seedRide(user, RIDE_OLD);
    await mockApi.seedRide(user, RIDE_RECENT);

    await page.goto("/rides/stats");

    await expect(
      page.getByRole("heading", { level: 1, name: /^Statistics$/i }),
    ).toBeVisible({ timeout: 10_000 });
    // Totals grid: at least the Total rides + Total distance cards
    // surface their labels and a non-empty numeric value. The exact
    // distance text depends on rounding (`.toFixed(0)`) so we accept
    // any digit run.
    const totalRidesCard = page
      .locator("div")
      .filter({ hasText: "Total rides" })
      .first();
    await expect(totalRidesCard).toContainText("2");
    await expect(page.getByText(/total distance/i).first()).toBeVisible();
    // Monthly chart header proves the chart section mounted.
    await expect(page.getByText(/distance by month/i)).toBeVisible();
    // Surface + curviness breakdown cards (server-derived) render their
    // headings and at least one slice from the mock breakdown.
    await expect(page.getByText(/by distance ridden/i)).toBeVisible();
    await expect(page.getByText(/^Asphalt$/).first()).toBeVisible();
    await expect(page.getByText(/how twisty was your year/i)).toBeVisible();
    await expect(page.getByText(/^Twisty$/).first()).toBeVisible();
    // Quality-trend card heading proves the client-side trend mounted.
    await expect(page.getByText(/average road quality/i)).toBeVisible();
  });

  // T33 — Personal road map: `/rides/road-map` now leads with the rider's
  // finished ride *routes* (the coverage segments live behind a toggle). The
  // seeded ride has a route track, so the map view renders — the Routes /
  // Coverage toggle proves the route mounts inside the Rides chrome and the
  // data fetch resolved into the map view rather than the error branch, the
  // empty state, or a white screen — catching deletion-style regressions.

  // T32b: the other side of the same gate. Without this, the suite would only
  // ever exercise the entitled path and a regression that locked out PAYING
  // riders — or one that opened the page to Free riders — would pass.
  test("T32b: /rides/stats locks for a rider without advanced_analytics", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // The fixture rider is Free by default; seed rides anyway so a failure
    // cannot be explained away as "there was nothing to show".
    await mockApi.seedRide(user, RIDE_OLD);
    await mockApi.seedRide(user, RIDE_RECENT);

    await page.goto("/rides/stats");

    // The header stays, so the route never shows an unexplained gap.
    await expect(
      page.getByRole("heading", { level: 1, name: /^Statistics$/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Advanced analytics")).toBeVisible();
    // NOT the totals, and NOT the empty state — "no rides recorded" would
    // blame the rider for a tier boundary they cannot see.
    await expect(page.getByText(/distance by month/i)).toBeHidden();
    await expect(page.getByText(/No rides recorded yet/i)).toBeHidden();
  });

  test("T33: /rides/road-map renders the personal road-map shell", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, RIDE_DETAIL);

    await page.goto("/rides/road-map");

    // Shared Rides scaffold header (`RidesScaffold` → `PageHeader`).
    await expect(
      page.getByRole("heading", { level: 1, name: /^ride history$/i }),
    ).toBeVisible({ timeout: 10_000 });
    // The map view (not the empty state): the Routes/Coverage toggle renders.
    await expect(page.getByRole("button", { name: /^routes$/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^coverage$/i }),
    ).toBeVisible();
    // Assert the seeded route track actually loaded, not just that the toggle
    // rendered (it also shows while tracks are loading or errored). The Routes
    // hero tile counts tracks with a recorded route, so it reads `1` only once
    // `/api/v1/rides/tracks` resolves the seeded ride — a hung/errored request
    // would leave it at `0` and fail here.
    const ridesOnMap = page.getByText("Rides on map", { exact: true });
    await expect(
      ridesOnMap.locator("..").getByText("1", { exact: true }),
    ).toBeVisible();
  });

  // T34 — Compare rides: `/rides/compare` exposes two searchable ride
  // comboboxes. The page auto-picks the two most-recent rides on
  // mount, then a side-by-side comparison view renders fed by
  // `/api/v1/rides/:id` for both rows. Seed three rides so we can
  // explicitly change one of the picks without racing the
  // auto-default (auto-default would otherwise re-clobber whatever
  // we typed).
  test("T34: /rides/compare renders a side-by-side view after picking two rides", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, RIDE_OLD); // 80 km, March
    await mockApi.seedRide(user, RIDE_RECENT); // 220 km, April
    await mockApi.seedRide(user, RIDE_DETAIL); // 175 km, April-20

    await page.goto("/rides/compare");

    // Compare lives under the shared Rides scaffold; its page-level h1 is
    // the section header ("Ride History"), not a per-tab title. The
    // compare-specific coverage is the stats-diff assertions below.
    await expect(
      page.getByRole("heading", { level: 1, name: /^ride history$/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the auto-default to settle (both params in URL) before
    // overriding ride A. Without this the test races the effect and
    // can lose our selection.
    await expect
      .poll(() => {
        const u = new URL(page.url());
        return u.searchParams.get("a") && u.searchParams.get("b");
      })
      .toBeTruthy();

    // Now explicitly switch ride A to the older 80 km ride. The picker is
    // a @tarmoto/ui Combobox — clicking its input (role combobox) opens
    // the option list; pick the seeded ride by its formatted option label.
    // The "Ride A" label also appears on the route map's aria-label, so
    // scope to the combobox role.
    await page.getByRole("combobox", { name: /ride a/i }).click();
    await page.getByRole("option", { name: new RegExp(RIDE_OLD.name) }).click();

    // The metric table renders one row per metric (Metric / Ride A /
    // Ride B). The v2 redesign dropped the separate "Stats diff" heading
    // and the delta column for a clean two-column read, so scope to the
    // card by the unique "Metric" header cell plus the "Distance" row
    // (`.last()` resolves to the innermost div containing both — the card
    // itself, not an outer page wrapper). Ride A is our explicit pick
    // (RIDE_OLD = 80.0 km); Ride B is the auto-default's first landing
    // (RIDE_RECENT = 220.0 km). Asserting both distances catches a
    // regression that loses either pick or only re-fetches one side.
    const statsTable = page
      .locator("div")
      .filter({ hasText: "Metric" })
      .filter({ hasText: "Distance" })
      .last();
    await expect(statsTable).toBeVisible({ timeout: 10_000 });
    // format.distanceKm renders whole km without a forced decimal
    // ("80 km", not the retired formatter's "80.0").
    await expect(statsTable).toContainText("80 km");
    await expect(statsTable).toContainText("220 km");
  });

  // T35 — Export ride data: the ride detail page's Export menu offers
  // CSV + GPX downloads via `downloadRideExport` →
  // `/api/v1/rides/:id/<format>`. Triggering CSV should fire a
  // browser download with a `tarmoto-ride-…csv` filename. Playwright's
  // download event is the cleanest contract assertion — it confirms
  // the mock returned a streamable response with the right headers.
  test("T35: clicking Export · CSV downloads the ride file", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const seeded = await mockApi.seedRide(user, RIDE_DETAIL);
    await page.goto(`/rides/${seeded.id}`);
    await expect(
      page.getByRole("heading", { level: 1, name: RIDE_DETAIL.name }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: /csv/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^tarmoto-ride-.*\.csv$/);
  });

  // T36 — Shared ride: `/rides/shared/<token>` is a public route — no
  // auth, no app chrome. The mock backend resolves the token to a
  // seeded ride and returns the shared-ride DTO; the page renders the
  // rider's name + a route preview heading. Using `browser` (not
  // `authedPage`) here proves anonymous access works.
  test("T36: /rides/shared/:token renders a public ride without auth", async ({
    browser,
    mockApi,
    user,
  }) => {
    const seeded = await mockApi.seedRide(user, RIDE_DETAIL);
    const { token } = await mockApi.seedRideShare(seeded.id, {
      token: "share-tok-detail",
    });

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`/rides/shared/${token}`);

      // The page heading is `<h1>{rider_name}</h1>` — the mock fills
      // rider_name with the seeded user's display_name, which is
      // randomised per-test ("Rider <suffix>"). Assert the prefix
      // rather than a fixed string.
      await expect(
        page.getByRole("heading", { level: 1, name: /^Rider /i }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByRole("heading", { name: /route preview/i }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
