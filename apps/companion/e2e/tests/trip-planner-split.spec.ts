import { test, expect } from "../fixtures";

// Addendum two-phase flow: the route is LIVE; days are computed on demand
// by "Split into days" and persist through save (materializeSplit).
test.describe("trip planner — split into days", () => {
  test("splitting a routed trip populates the day column and survives save + reload", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // Seed a single-day routed trip (working-day model) long enough for
    // a forced 2-day split.
    const trip = await mockApi.seedTrip(user, {
      title: "Splitter run",
      route_geometry: Array.from({ length: 60 }, (_, i) => ({
        lat: 49.0 + i * 0.02,
        lng: 15.5 + i * 0.01,
      })),
      waypoints: [
        { lat: 49.0, lng: 15.5, name: "Start", type: "start" },
        { lat: 50.18, lng: 16.09, name: "Finish", type: "end" },
      ],
      distance_km: 160,
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });

    // Pre-split there is NO day concept: no day column, no header count
    // (revision 2 §B/§C).
    await expect(page.getByLabel("Day 1")).toHaveCount(0);
    await expect(page.getByText(/\d+ days ·/)).toHaveCount(0);

    // Day planning is an opt-in: expand "Plan as multi-day trip" first
    // (BUILD tab is the default), then force 2 days and split.
    await page.getByText("Plan as multi-day trip").click();
    await page.getByRole("button", { name: "Force 2 days" }).click();
    await page.getByRole("button", { name: /^Split into days$/i }).click();

    // Day cards appear (aria-labelled divs in the day column).
    await expect(page.getByLabel("Day 1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Day 2")).toBeVisible();
    // The primary button now reads Re-split.
    await expect(page.getByRole("button", { name: /Re-split/i })).toBeVisible();

    // A route edit marks the split stale.
    // Route preferences collapsed to a summary row in revision 3 —
    // expand it before reaching for the avoid checkboxes.
    await page.getByRole("button", { name: "Route preferences" }).click();
    await page.getByLabel(/avoid motorways/i).click({ force: true });
    await expect(page.getByText(/Route changed/).first()).toBeVisible();

    // Re-split refreshes the days. Two equivalent re-split buttons exist
    // while stale (the BUILD primary now reads "Re-split" and role-name
    // matching is case-insensitive) — exact-match the day-column shortcut.
    await page.getByRole("button", { name: "RE-SPLIT", exact: true }).click();
    await expect(page.getByText(/Route changed/)).toHaveCount(0, {
      timeout: 10_000,
    });

    // Save persists the materialized days; wait for live routing to settle
    // first (the avoid-motorways toggle re-fires it).
    const saveRouteBtn = page.getByRole("button", { name: /save route/i });
    await expect(saveRouteBtn).toBeEnabled({ timeout: 10_000 });
    await saveRouteBtn.click();
    await expect(page.getByText(/route saved/i)).toBeVisible({
      timeout: 10_000,
    });

    // Reload: the saved trip comes back as an existing split with 2 days.
    await page.goto(`/trips/planner?tripId=${trip.id}`);
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByLabel("Day 1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Day 2")).toBeVisible();
  });
});
