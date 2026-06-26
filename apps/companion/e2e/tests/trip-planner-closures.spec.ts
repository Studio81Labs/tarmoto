import { test, expect } from "../fixtures";

test.describe("trip planner — closures (T13)", () => {
  // T13 — Closures visible: with a seeded closure overlapping the
  // trip route, opening the planner with a seeded trip (which already
  // has day-1 route geometry) should surface the closures panel's
  // route-warnings copy. `useClosures` fires `POST /closures/check-route`
  // once the trip has days; the mock reports every seeded closure as
  // crossing the route, so the panel renders the "Current trip
  // crosses 1 active closure" line.
  //
  // We seed a trip WITH existing route geometry so the dirty-gate
  // keeps the live-routing hook idle on open — no routing call needed
  // to establish the trip days that trigger the closures check.
  test("T13: a seeded closure surfaces on the planner's route-warnings panel", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedClosure({
      title: "Stelvio Pass closed",
      severity: "full",
      reason: "roadworks",
    });

    const trip = await mockApi.seedTrip(user, {
      title: "Alpine route",
      route_geometry: [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.48, lng: 10.39 },
        { lat: 46.55, lng: 10.45 },
      ],
      waypoints: [
        { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
        { lat: 46.55, lng: 10.45, name: "Finish", type: "end" },
      ],
      distance_km: 20,
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);

    // Wait for the map — confirms the planner has loaded the trip.
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });

    // The closures panel renders "Current trip crosses {count}
    // active {label}" once `useClosures.checkRoute` resolves with a
    // non-empty list. The mock reports the seeded closure for any
    // non-empty route, so a successful trip load guarantees this
    // copy lands. Use a substring match (the i18n `t()` swap might
    // adjust punctuation; the number + "closure" anchor is stable).
    await expect(
      page.getByText(/current trip crosses\s+1\s+active closure/i),
    ).toBeVisible({ timeout: 15_000 });

    // The closure title also surfaces in the per-row list inside
    // the route-warnings block — proves the closure object itself
    // round-tripped via `/closures/check-route`, not just via the
    // unscoped bbox `/closures` list. Anchor on the count copy
    // (which only exists in the route-warnings block), then walk
    // up to its immediate parent `<div>` (the route-warnings card)
    // so a regression that drops the per-row list inside that card
    // while keeping the bbox surface alive fails the test.
    const routeWarningsCard = page
      .getByText(/current trip crosses\s+1\s+active closure/i)
      .locator("xpath=ancestor::div[1]");
    await expect(
      routeWarningsCard.getByText(/stelvio pass closed/i),
    ).toBeVisible();
  });
});
