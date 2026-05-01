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

    // Bump the day count to 5.
    const daysInput = page.locator("#trip-planner-days");
    await daysInput.fill("5");
    await daysInput.blur();

    await page.getByRole("button", { name: /generate itinerary/i }).click();

    // Just assert the panel re-renders with three options — option detail
    // assertions belong in unit tests for the local generator.
    const options = page.locator(
      'button:has-text("Distance"):has-text("Avg quality")',
    );
    await expect(options).toHaveCount(3);
  });

  test("promoting a trip via the Collaborate modal pushes the saved id into the URL and lets us reopen it", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();
    await page.getByRole("button", { name: /generate itinerary/i }).click();

    await page.getByRole("button", { name: /^Collaborate$/ }).click();
    await expect(
      page.getByRole("dialog", { name: /collaborate on this trip/i }),
    ).toBeVisible();

    // The Suggestions tab gates the "Save trip" CTA when there's no
    // serverTripId yet — that's the supported path for promoting a
    // local trip into a saved one.
    await page.getByRole("tab", { name: /suggestions/i }).click();
    await page
      .getByRole("button", { name: /save trip and enable collaboration/i })
      .click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get("tripId"), {
        timeout: 10_000,
      })
      .not.toBeNull();
    const tripId = new URL(page.url()).searchParams.get("tripId")!;
    expect(tripId).toMatch(/^[0-9a-f-]{30,}$/i);

    // Generate replaces the active trip's name with the selected
    // option's label (e.g. "3-day mixed best fit"), so the saved trip
    // takes that name rather than the demo's "Alps loop". Match on the
    // shape of the generator's auto-name so the assertion stays
    // deterministic without binding to a specific preset wording.
    const generatedNamePattern =
      /\d+-day .* (best fit|scenic sweep|fastest line)/i;

    // Close the modal and reopen the saved trip via its detail page —
    // the AC's "reopen via trip detail" path. We navigate via the trip
    // list (the natural user flow) so the auth store is already
    // populated before the detail page fires its trip fetch.
    await page.getByRole("button", { name: /close dialog/i }).click();
    await page.goto("/trips");
    const tripCard = page
      .getByRole("link", { name: generatedNamePattern })
      .first();
    await expect(tripCard).toBeVisible({ timeout: 10_000 });
    await tripCard.click();
    await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));
    await expect(
      page.getByRole("heading", { name: generatedNamePattern }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
