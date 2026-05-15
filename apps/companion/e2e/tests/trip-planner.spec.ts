import { test, expect } from "../fixtures";

test.describe("trip planner", () => {
  test("loading the demo trip and generating options shows three route cards", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");

    // Empty canvas: the "Load demo trip" CTA is only rendered when there
    // is no active trip yet.
    await page.getByRole("button", { name: /load demo trip/i }).click();

    await expect(
      page.getByRole("heading", { name: /alps loop/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /generate itinerary/i }).click();

    // Three preset itineraries appear (best-fit / scenic / fastest).
    await expect(page.getByText(/Distance/i).first()).toBeVisible();
    const options = page.locator(
      'button:has-text("Distance"):has-text("Avg quality")',
    );
    await expect(options).toHaveCount(3);
  });

  test("selecting a generated option flips the Active badge", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();
    await page.getByRole("button", { name: /generate itinerary/i }).click();

    const options = page.locator(
      'button:has-text("Distance"):has-text("Avg quality")',
    );
    await expect(options).toHaveCount(3);

    // The first option starts active. Pick the third one and verify the
    // Active badge moves with the selection.
    await options.nth(2).click();
    await expect(options.nth(2).getByText(/^Active$/)).toBeVisible();
    await expect(options.nth(0).getByText(/^Active$/)).toBeHidden();
  });

  test("adjusting trip parameters before generation produces options that respect the input", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();

    // Bump the day count and daily target so the backend mock builds
    // a larger generated geometry set from the submitted controls.
    const daysInput = page.locator("#trip-planner-days");
    await daysInput.fill("5");
    await daysInput.blur();
    const dailyKmInput = page.locator("#trip-planner-daily-km");
    await dailyKmInput.fill("300");
    await dailyKmInput.blur();

    await page.getByRole("button", { name: /generate itinerary/i }).click();

    // Just assert the panel re-renders with three options — option detail
    // assertions belong in unit tests for the local generator.
    const options = page.locator(
      'button:has-text("Distance"):has-text("Avg quality")',
    );
    await expect(options).toHaveCount(3);
    await expect(options.first()).toContainText("1500km");
  });

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

  test("saving a backend-generated trip lets us reopen the same route detail", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();
    await page.getByRole("button", { name: /generate itinerary/i }).click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get("tripId"), {
        timeout: 10_000,
      })
      .not.toBeNull();
    const tripId = new URL(page.url()).searchParams.get("tripId")!;
    expect(tripId).toMatch(/^[0-9a-f-]{30,}$/i);

    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));
    await expect(page.getByText(/250\.0 km/).first()).toBeVisible({
      timeout: 10_000,
    });

    // Reopen via the trip list, which verifies the persisted backend
    // geometry/detail is what the detail page reads after navigation.
    await page.goto("/trips");
    const tripCard = page.getByRole("link", { name: /alps loop/i }).first();
    await expect(tripCard).toBeVisible({ timeout: 10_000 });
    await tripCard.click();
    await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));
    await expect(
      page.getByRole("heading", { name: /alps loop/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/250\.0 km/).first()).toBeVisible();
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
