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

    // "Save route" is enabled: the trip already has geometry and ≥2 waypoints.
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 5_000 });
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

    // Save the route — this calls PUT /trips/:id/route on the existing trip.
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 5_000 });
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
