import { test, expect } from "../fixtures";

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
    // uses the compact "Xh Ym" form, and QUALITY renders the QualityBars
    // glyph (aria-labelled "Quality N of 5"; 4.6 → tier 5).
    const recentRow = page
      .getByRole("row")
      .filter({ hasText: RIDE_RECENT.name });
    await expect(recentRow.getByText("220")).toBeVisible();
    await expect(recentRow.getByText("4h 0m")).toBeVisible();
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

    // Filters live inside <label> wrappers — getByLabel resolves to the
    // wrapped input. The label text is rendered through the i18n
    // helper with a trailing space ("From "), so the regex matches a
    // word-boundary stop rather than the end of the accessible name.
    // After each fill we blur the field; the page's `onChange` handler
    // only commits the new value once the input dispatches a change
    // event, which Playwright's `fill` triggers but the React
    // synchronous render on the next tick needs a small breather to
    // settle before the URL reflects it.
    const fromField = page.getByLabel(/^from\b/i);
    const toField = page.getByLabel(/^to\b/i);
    const minKmField = page.getByLabel(/^min km\b/i);
    await fromField.fill("2026-04-01");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("from"))
      .toBe("2026-04-01");
    await toField.fill("2026-04-30");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("to"))
      .toBe("2026-04-30");
    await minKmField.fill("100");
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

  // T31 — Ride detail: clicking the "Open ride" link routes to
  // `/rides/[id]` and the page shows the trip metadata. The H1 reads
  // "Ride on <date>" (the page doesn't surface `ride.name` in the
  // header), and the stat cards expose distance / duration / avg
  // speed / elevation gain from the detail endpoint.
  test("T31: clicking through to a ride opens its detail with route + stats", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
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

    // Stat cards key off the seeded metadata. The value + unit are
    // rendered inline (e.g. "90" and "km/h" inside the same paragraph,
    // separated only by an inner <span>), so we scope to the StatCard
    // by its label text and assert the value appears inside that card.
    // Without hydration, the StatCard would render "—" and these
    // assertions would fail.
    const avgSpeedCard = page
      .locator("div")
      .filter({ hasText: "Avg speed" })
      .filter({ hasText: "km/h" })
      .first();
    await expect(avgSpeedCard).toContainText("90");

    const distanceCard = page
      .locator("div")
      .filter({ hasText: "Distance" })
      .filter({ hasText: "km" })
      .first();
    await expect(distanceCard).toContainText("175.0");

    const elevationCard = page
      .locator("div")
      .filter({ hasText: "Elevation gain" })
      .first();
    await expect(elevationCard).toContainText("1200");

    // Distinguish "map rendered with the seeded geometry" from the
    // "No GPS track was recorded" fallback: both branches share the
    // same SectionHeader subtitle above them, so asserting on the
    // subtitle alone wouldn't catch a regression that dropped to the
    // fallback. The route map element is aria-labelled, and the
    // fallback only appears when `route_geometry` is null or has
    // fewer than 2 points — we assert both directions explicitly.
    // `RideRouteMap` renders a `<div aria-label="Ride route map">` — a
    // bare div doesn't carry an implicit landmark role, so we locate
    // it by its aria-label rather than `getByRole("region", …)`.
    await expect(page.getByLabel(/ride route map/i)).toBeVisible();
    await expect(page.getByText(/no gps track was recorded/i)).toBeHidden();

    // Speed graph: assert two independent signals so a regression in
    // either the subtitle wiring OR the chart rendering itself fails
    // the test.
    //
    // 1) The SectionHeader subtitle reads "X km/h peak across recorded
    //    segments" only when segments hydrated; the empty-state copy is
    //    hidden. Catches a regression that drops segment wire data.
    // 2) The chart component renders an `<svg role="img" aria-label=
    //    "Ride speed graph">`. Asserting that directly catches a
    //    regression that deletes the chart or makes it return null
    //    even when the subtitle (which is computed upstream) still
    //    shows the populated copy.
    await expect(
      page.getByText(/km\/h peak across recorded segments/i),
    ).toBeVisible();
    await expect(
      page.getByText(/speed samples are attached once segment telemetry/i),
    ).toBeHidden();
    await expect(
      page.getByRole("img", { name: /ride speed graph/i }),
    ).toBeVisible();

    // Segments table: each seeded segment surfaces by its road_name.
    // Also covers the "Per-segment road quality, speed, and lean
    // angle" panel the doc names alongside the chart.
    await expect(page.getByText("Stelvio Pass")).toBeVisible();
    await expect(page.getByText("Bormio Loop")).toBeVisible();

    // Elevation profile: per-sample elevation isn't recorded yet, so
    // `ElevationProfileChart` always renders the empty state today.
    // Assert both the section header and the empty-state copy so a
    // regression that deletes the section (or breaks the chart slot)
    // fails T31 — covering the "elevation profile" line of the doc
    // even though it's currently a flat empty state. Replace with a
    // real-data assertion when per-sample elevation lands.
    await expect(
      page.getByRole("heading", { name: /elevation profile/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/no elevation profile was recorded for this ride/i),
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
    await expect(page.getByText(/monthly distance —/i)).toBeVisible();
  });

  // T33 — Personal road map: `/rides/road-map` overlays the rider's
  // ridden *segments* on a map. The mock's exploration endpoints report
  // zero ridden segments (seeded rides don't synthesise exploration
  // coverage), so the page correctly settles into its empty state. The
  // assertions prove the route mounts inside the Rides chrome and the
  // exploration fetch resolved into the empty view rather than the error
  // branch or a white screen — catching deletion-style regressions.
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
    // Road-map empty state proves the exploration fetch resolved.
    await expect(page.getByText(/your road map is empty/i)).toBeVisible();
    await expect(
      page.getByText(/every road you ride gets layered/i),
    ).toBeVisible();
  });

  // T34 — Compare rides: `/rides/compare` exposes two <select>
  // dropdowns. The page auto-picks the two most-recent rides on
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
    const a = await mockApi.seedRide(user, RIDE_OLD); // 80 km, March
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

    // Now explicitly switch ride A to the older 80 km ride. The
    // "Ride A" label appears both on the picker `<select>` and the
    // route map's aria-label, so scope to the combobox role.
    await page.getByRole("combobox", { name: /ride a/i }).selectOption(a.id);

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
    await expect(statsTable).toContainText("80.0");
    await expect(statsTable).toContainText("220.0");
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

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /export csv/i }).click(),
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
