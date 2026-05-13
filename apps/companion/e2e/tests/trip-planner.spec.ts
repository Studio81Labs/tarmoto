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
});
