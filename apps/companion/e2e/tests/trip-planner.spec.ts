import { test, expect } from "../fixtures";

test.describe("trip planner", () => {
  // NOTE: "Generate itinerary" flow (button + option cards + old "Save" button)
  // was removed in Phase-1. The three tests that drove that UI have been
  // deleted. See the commit message for details.

  test("restoring a planner region surfaces Fun Zones and top roads", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner?bbox=10.3,46.45,10.6,46.7");
    const canvas = page.locator(".maplibregl-canvas").first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText("Mock Ridge Fun Zone")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /Mock Ridge Fun Zone/i }).click();
    await expect(page.getByText("Top roads")).toBeVisible();
    await expect(page.getByText("Mock Ridge Road")).toBeVisible();
  });

  // Manual-flow: seed a trip that already has day-1 route geometry and open
  // it via `?tripId=`. The dirty-gate suppresses live routing on open (the
  // existing geometry is preserved), so the "Save route" button is enabled
  // immediately. Clicking it calls PUT /trips/:id/route and shows the
  // success toast.
  test("seeded route renders and Save route persists via the manual flow", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const trip = await mockApi.seedTrip(user, {
      title: "Alps loop",
      route_geometry: [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.55, lng: 10.45 },
        { lat: 46.63, lng: 10.52 },
      ],
      waypoints: [
        { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
        { lat: 46.63, lng: 10.52, name: "Finish", type: "end" },
      ],
      distance_km: 125,
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);

    // Wait for the map to be visible — proves the planner loaded the trip.
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });

    // The trip name from the seed appears in the left-panel header.
    await expect(
      page.getByRole("heading", { name: /alps loop/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Save route is gated on a dirty draft (so a no-op save can't reroute a
    // loaded canonical/imported route). Toggle an avoid-routing option to mark
    // the draft edited — the planner wires this to markRouteDirty.
    await page.getByLabel(/avoid highways/i).click({ force: true });

    // Now "Save route" is enabled (dirty + existing geometry + ≥2 waypoints).
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 10_000 });
    await saveRouteBtn.click();

    // The success toast fires after the PUT /trips/:id/route resolves.
    await expect(page.getByText(/route saved/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  // Reopen flow: seed a trip → open planner → click Save route → navigate to
  // /trips → click back in → verify the route detail is still present.
  test("saving a route lets us reopen the same trip detail", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const trip = await mockApi.seedTrip(user, {
      title: "Alps loop",
      route_geometry: [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.55, lng: 10.45 },
        { lat: 46.63, lng: 10.52 },
      ],
      waypoints: [
        { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
        { lat: 46.63, lng: 10.52, name: "Finish", type: "end" },
      ],
      distance_km: 125,
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);

    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });

    // Dirty the draft (toggle an avoid option) so Save route enables — see the
    // manual-flow test above for why the dirty-gate exists.
    await page.getByLabel(/avoid highways/i).click({ force: true });

    // Save the route — this calls PUT /trips/:id/route on the existing trip.
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 10_000 });
    await saveRouteBtn.click();
    await expect(page.getByText(/route saved/i)).toBeVisible({
      timeout: 10_000,
    });

    // After saving, navigate to the trip list and reopen the trip.
    await page.goto("/trips");
    const tripCard = page.getByRole("link", { name: /alps loop/i }).first();
    await expect(tripCard).toBeVisible({ timeout: 10_000 });
    await tripCard.click();
    await expect(page).toHaveURL(new RegExp(`/trips/${trip.id}$`));
    await expect(
      page.getByRole("heading", { name: /alps loop/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // Multi-day flow: seed a two-day trip directly (day 2 linked), open the
  // planner, dirty the route, Save, then reload and verify both day tabs
  // are restored and day 2 is still linked.
  //
  // We seed a pre-built 2-day trip rather than driving the "Add day" +
  // map-click flow in Playwright because the planner's day-2 hint overlay
  // intercepts pointer events on the canvas until dismissed, making a
  // reliable waypoint-placement sequence fragile across retries. The
  // important coverage here is:
  //   a) the mock backend accepts the multi-day PUT /route shape,
  //   b) `saveDays()` correctly serialises `startLinked` per day, and
  //   c) the reloaded planner shows 2 day tabs with day 2 linked.
  test("building, saving, and reloading a two-day trip restores both days and linked state", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // Seed a 2-day trip: day 1 has a complete routed geometry; day 2 has
    // a linked start (day 1 end) and its own end, so both are "complete"
    // and the planner can save without prompting for more waypoints.
    const trip = await mockApi.seedTrip(user, {
      title: "Two-day Alps",
      days: [
        {
          route_geometry: [
            { lat: 46.47, lng: 10.37 },
            { lat: 46.55, lng: 10.45 },
            { lat: 46.63, lng: 10.52 },
          ],
          waypoints: [
            { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
            { lat: 46.63, lng: 10.52, name: "Finish Day 1", type: "end" },
          ],
          start_linked: false,
          distance_km: 80,
        },
        {
          route_geometry: [
            { lat: 46.63, lng: 10.52 },
            { lat: 46.71, lng: 10.6 },
            { lat: 46.79, lng: 10.68 },
          ],
          waypoints: [
            // Linked start: same coords as day 1's end.
            { lat: 46.63, lng: 10.52, name: "Day 2 Start", type: "start" },
            { lat: 46.79, lng: 10.68, name: "Finish Day 2", type: "end" },
          ],
          start_linked: true,
          distance_km: 85,
        },
      ],
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);

    // Wait for the map and trip heading.
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: /two-day alps/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Both day tabs should be visible on open.
    await expect(
      page.getByRole("button", { name: /Day 1/i }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /Day 2/i }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Day 2 is linked — the "Link to previous day" button must NOT appear
    // (it only renders when startLinked === false for day index ≥ 1).
    await expect(
      page.getByRole("button", { name: /link to previous day/i }),
    ).not.toBeVisible();

    // Toggle "Avoid highways" to dirty the route. Toggling marks ALL days
    // stale and fires live routing for the selected day (day 1). We wait
    // 1.5 s — enough for the 300 ms debounce + near-instant mock response
    // to clear day 1 from stalePreviewDays — then switch to day 2 so live
    // routing fires + clears day 2. Only once stalePreviewDays is empty
    // does "Save route" enable.
    await page.getByLabel(/avoid highways/i).click({ force: true });

    // Give day-1 routing time to complete (300 ms debounce + mock latency).
    await page.waitForTimeout(1_500);

    // Click day 2 so live routing fires for it too.
    await page.getByRole("button", { name: /Day 2/i }).first().click();

    // "Save route" should become enabled once both day routes have settled.
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 10_000 });
    await saveRouteBtn.click();

    // Success toast.
    await expect(page.getByText(/route saved/i)).toBeVisible({
      timeout: 10_000,
    });

    // Reload the planner using the same trip id — verifies that the saved
    // multi-day state round-trips through the mock backend correctly.
    await page.goto(`/trips/planner?tripId=${trip.id}`);
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: /two-day alps/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Both day tabs must be present after reload.
    await expect(
      page.getByRole("button", { name: /Day 1/i }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /Day 2/i }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Day 2 is still linked after the save + reload round-trip. The "Link
    // to previous day" button is absent because startLinked stayed true.
    await expect(
      page.getByRole("button", { name: /link to previous day/i }),
    ).not.toBeVisible();
  });

  // T4 (segment sidebar) is **blocked at e2e**.
  //
  // The `SegmentSidebar` keys off `activeTrip.days[i].segments`, but the
  // wire shape (`TripDetailDay` in `lib/trip-from-detail.ts`) doesn't
  // carry that field and `tripFromDetail` never populates it — segments
  // are computed locally only when the user mutates waypoints
  // (`trip-planner-builder.ts::rebuildPlannerDay`). After a fresh
  // Generate the sidebar therefore renders the empty state in
  // production, identical to its pre-Generate state. A test that
  // asserts the sidebar mounts before-and-after Generate doesn't gate
  // anything; a test that seeds `segments` in the mock would only
  // validate code that isn't wired in production.
  //
  // Per-segment card content is covered by `RoadPreviewCard.test.tsx`.
  // The wire-data work that would unblock a meaningful T4 belongs in
  // the OpenAPI / backend day-DTO conversation, tracked separately.
});
