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
