import { test, expect } from "../fixtures";

test.describe("trip planner — closures (T13)", () => {
  // T13 — Closures visible: with a seeded closure overlapping the
  // demo trip's region, opening the planner + generating an
  // itinerary should surface the closures panel's route-warnings
  // copy. `useClosures` fires `POST /closures/check-route` once the
  // trip has days; the mock reports every seeded closure as
  // crossing the route, so the panel renders the "Current trip
  // crosses 1 active closure" line.
  test("T13: a seeded closure surfaces on the planner's route-warnings panel", async ({
    authedPage: page,
    mockApi,
  }) => {
    await mockApi.seedClosure({
      title: "Stelvio Pass closed",
      severity: "full",
      reason: "construction",
    });

    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();
    await page.getByRole("button", { name: /generate itinerary/i }).click();

    // Wait for the URL to acquire a tripId (proves the planner has
    // a generated trip). Closures-panel rendering keys off the
    // post-generate trip having days.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tripId"), {
        timeout: 10_000,
      })
      .not.toBeNull();

    // The closures panel renders "Current trip crosses {count}
    // active {label}" once `useClosures.checkRoute` resolves with a
    // non-empty list. The mock reports the seeded closure for any
    // non-empty route, so a successful generate guarantees this
    // copy lands. Use a substring match (the i18n `t()` swap might
    // adjust punctuation; the number + "closure" anchor is stable).
    await expect(
      page.getByText(/current trip crosses\s+1\s+active closure/i),
    ).toBeVisible({ timeout: 15_000 });

    // The closure title also surfaces in the per-row list under the
    // route-warnings block — proves the closure object itself
    // round-tripped, not just the count. The title repeats across
    // the bbox-list, route-warnings, and compact-row sections, so
    // anchor to the first occurrence.
    await expect(page.getByText(/stelvio pass closed/i).first()).toBeVisible();
  });
});
