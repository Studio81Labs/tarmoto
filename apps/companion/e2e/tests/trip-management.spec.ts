import { test, expect } from "../fixtures";

test.describe("trip management", () => {
  // T7 — Duplicate trip: from the /trips list, opening a trip's action
  // menu and clicking "Duplicate" creates a new draft with a "(copy)"
  // suffix that appears alongside the source. The doc names the trip
  // detail page as the entry point, but the shipping UX puts the
  // action in the list card's overflow menu — testing the actual UX
  // rather than the doc's wording.
  test("T7: duplicating a trip from the list creates a draft with a (copy) suffix", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const source = await mockApi.createTrip(user, {
      title: "Tatry Tour",
      num_days: 3,
    });

    await page.goto("/trips");
    // The source card's accessible name starts with the title, then
    // "draft", then the days/km strip. The copy's name will contain
    // "(copy)". Anchor on the no-parens form so the source matcher
    // isn't ambiguous after the duplicate adds a second card.
    const sourceCard = page.getByRole("link", {
      name: new RegExp(`^${source.title}\\s+draft`, "i"),
    });
    await expect(sourceCard).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole("button", {
        name: new RegExp(`Trip actions for ${source.title}`, "i"),
      })
      .click();
    await page.getByRole("button", { name: /^Duplicate$/i }).click();

    // The duplicate POST is non-blocking; the list re-renders once the
    // mock returns the new id. Match the suffix loosely so future copy
    // tweaks (e.g. "(2)" instead of "(copy)") don't break the test
    // unnecessarily — the contract under test is "a new entry appears
    // referencing the source title".
    const copyCard = page.getByRole("link", {
      name: new RegExp(`${source.title}.*\\(copy\\)`, "i"),
    });
    await expect(copyCard).toBeVisible({ timeout: 10_000 });
    await expect(sourceCard).toBeVisible();
  });

  // T8 — Edit existing trip: navigating to `/trips/[id]/edit` should
  // redirect into the planner with the existing trip context loaded.
  // The route is a thin client redirect that hands off to
  // `/trips/planner?tripId=<id>`; the planner then hydrates the trip
  // detail. We assert the redirect happens and the planner mounts.
  test("T8: /trips/:id/edit redirects into the planner with the trip context", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const source = await mockApi.createTrip(user, {
      title: "Edit Test Trip",
      num_days: 2,
    });

    await page.goto(`/trips/${source.id}/edit`);

    // Redirect target: the planner with the source tripId in the query.
    await expect(page).toHaveURL(
      new RegExp(`/trips/planner\\?tripId=${source.id}`),
      { timeout: 10_000 },
    );
    // Sanity check that the planner actually mounted — the generate
    // CTA is a stable affordance present in both empty and live trip
    // modes.
    await expect(
      page.getByRole("button", { name: /generate itinerary/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
