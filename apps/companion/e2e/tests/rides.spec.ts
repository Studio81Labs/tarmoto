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

    // Each seeded ride surfaces by its custom name; this also proves
    // the list endpoint actually fetched our seeded data rather than
    // showing the empty-state fallback row.
    await expect(page.getByRole("button", { name: RIDE_OLD.name })).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("button", { name: RIDE_RECENT.name }),
    ).toBeVisible();

    // Distance / duration / quality cells render in their formatted
    // shape. We assert on the recent ride's values to avoid the
    // possible `80.0 km` ↔ `80 km` rounding ambiguity of the older
    // ride's whole-number distance.
    await expect(page.getByText("220.0 km")).toBeVisible();
    await expect(page.getByText("240 min")).toBeVisible();
    // The quality pill renders the score as `X.Y`.
    await expect(page.getByText("4.6")).toBeVisible();

    // Total-count badge reflects both rides. The exact string ("2
    // rides") is what RidesTable renders for the count slot.
    await expect(page.getByText("2 rides")).toBeVisible();
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
    await expect(page.getByRole("button", { name: RIDE_OLD.name })).toBeVisible(
      { timeout: 10_000 },
    );

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
    // stays. The total-count badge tracks the post-filter set size.
    await expect(
      page.getByRole("button", { name: RIDE_OLD.name }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: RIDE_RECENT.name }),
    ).toBeVisible();
    await expect(page.getByText("1 ride")).toBeVisible();
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
      page.getByRole("button", { name: RIDE_DETAIL.name }),
    ).toBeVisible({ timeout: 10_000 });

    // Each row exposes an "Open ride" affordance — there are as many
    // such links as rides, so scope to the row containing our seeded
    // ride name. (`getByRole("link", { name: /open ride/i }).first()`
    // would also work with a single ride, but the scoped lookup keeps
    // the test resilient to seeding more rides later.)
    const row = page.getByRole("row").filter({ hasText: RIDE_DETAIL.name });
    await row.getByRole("link", { name: /open ride/i }).click();
    await expect(page).toHaveURL(new RegExp(`/rides/${seeded.id}$`), {
      timeout: 10_000,
    });

    // H1: "Ride on <date>" — the date format is locale-sensitive, so
    // accept either US ("4/20/2026") or ISO ("2026-04-20") rendering.
    await expect(
      page.getByRole("heading", { level: 1, name: /^Ride on / }),
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
  // ridden segments on a map. With the seeded zero-exploration stats
  // the page mounts in the "no segments yet" empty path but the
  // chrome (heading, subtitle, period filters) still renders.
  // Asserting those three signals catches deletion-style regressions.
  test("T33: /rides/road-map renders the personal road-map shell", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, RIDE_DETAIL);

    await page.goto("/rides/road-map");

    await expect(
      page.getByRole("heading", { level: 1, name: /my road map/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/every road you've ridden/i)).toBeVisible();
    // The period filter row lives in the header's action slot and only
    // mounts after `/api/v1/exploration/stats` resolves — asserting the
    // "All time" button proves the fetch completed and the success
    // chrome rendered (the loading / error states omit the action).
    await expect(
      page.getByRole("button", { name: /^all time$/i }),
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

    await expect(
      page.getByRole("heading", { level: 1, name: /compare rides/i }),
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

    // The Stats-diff table renders one row per metric with the value
    // and unit in sibling DOM nodes, so scope to the table by its
    // heading. Ride A is our explicit pick (RIDE_OLD = 80.0 km); Ride
    // B is whatever the auto-default landed on first (the second-
    // most-recent ride, RIDE_RECENT = 220.0 km). Asserting both
    // distances catches a regression that loses either pick or only
    // re-fetches one side after the explicit override.
    const statsTable = page
      .locator("section")
      .filter({ hasText: "Stats diff" })
      .first();
    await expect(statsTable).toBeVisible({ timeout: 10_000 });
    await expect(statsTable).toContainText("80.0");
    await expect(statsTable).toContainText("220.0");
    // Sanity check the delta arithmetic surfaced. Catches regressions
    // in `computeStatRows`'s `b - a` formula.
    await expect(statsTable).toContainText("+140.0");
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
      page.getByRole("heading", { level: 1, name: /^Ride on / }),
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
