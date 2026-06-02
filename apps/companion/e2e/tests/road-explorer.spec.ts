import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// The quality / surface / hazard filters are real `<input type="checkbox">`
// elements that are visually hidden with `sr-only` and toggled via their
// wrapping `<label>` (the styled square is a sibling span). Playwright's
// `.check()` / `.uncheck()` require the control itself to be visible, so they
// time out on the hidden input — toggle the way a rider does, by clicking the
// label. State assertions (`toBeChecked()`) still read the input directly.
async function toggleFilter(checkbox: Locator) {
  await checkbox.locator("xpath=ancestor::label[1]").click();
}

const MOCK_ROAD_SEGMENT_ID = "11111111-2222-4333-8444-555555555111";

async function selectMockRoadSegment(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            window as Window & {
              __tarmotoSelectExploreSegment?: (id: string) => void;
            }
          ).__tarmotoSelectExploreSegment,
      ),
    )
    .toBe("function");
  await page.evaluate((segmentId) => {
    (
      window as Window & {
        __tarmotoSelectExploreSegment?: (id: string) => void;
      }
    ).__tarmotoSelectExploreSegment?.(segmentId);
  }, MOCK_ROAD_SEGMENT_ID);
}

test.describe("road quality explorer", () => {
  test("the explorer is accessible without authentication", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");
      // Filter panel renders without redirecting to /login.
      await expect(page).not.toHaveURL(/\/login/);
      await expect(
        page.getByRole("heading", { name: /^filters$/i }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("toggling a quality filter mirrors the URL with ?q=...", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");

      const excellent = page.getByRole("checkbox", { name: /^excellent$/i });
      const good = page.getByRole("checkbox", { name: /^good$/i });
      const fair = page.getByRole("checkbox", { name: /^fair$/i });
      const poor = page.getByRole("checkbox", { name: /^poor$/i });
      const veryPoor = page.getByRole("checkbox", { name: /^very poor$/i });

      // All quality tiers default to ticked; the URL has no `q` param.
      await expect(excellent).toBeChecked();
      expect(new URL(page.url()).searchParams.has("q")).toBe(false);

      // Untick "Very poor" — the URL gains `q=excellent,good,fair,poor`.
      await toggleFilter(veryPoor);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("q"))
        .toBe("excellent,good,fair,poor");
      await expect(veryPoor).not.toBeChecked();
      await expect(excellent).toBeChecked();
      await expect(good).toBeChecked();
      await expect(fair).toBeChecked();
      await expect(poor).toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("loading the explorer with quality params hydrates the filter checkboxes", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Pre-load with only "excellent" selected.
      await page.goto("/explore?q=excellent");

      const excellent = page.getByRole("checkbox", { name: /^excellent$/i });
      const good = page.getByRole("checkbox", { name: /^good$/i });

      await expect(excellent).toBeChecked();
      await expect(good).not.toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("T27/T28: public explorer exposes regional closures and passes panels", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");

      // Closures + Passes are now opt-in info layers (#570) rather
      // than always-visible filter-column children. Toggle each on
      // before asserting the docked side panel mounts.
      await page.getByRole("button", { name: /^closures\s*$/i }).click();
      await page.getByRole("button", { name: /^passes\s*$/i }).click();

      await expect(page.getByText("Closures & roadworks")).toBeVisible();
      await expect(page.getByText("Seasonal passes")).toBeVisible();
      await expect(
        page.getByText("No active closures for this month yet."),
      ).toBeVisible();
      await expect(
        page.getByText("No mountain passes seeded yet."),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("the reset button clears all filter params from the URL", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore?q=excellent&s=asphalt&c=40");

      // Confirm we entered the page with non-default filter params.
      expect(new URL(page.url()).searchParams.get("q")).toBe("excellent");

      await page.getByRole("button", { name: /^reset$/i }).click();

      await expect
        .poll(() => {
          const u = new URL(page.url());
          return ["q", "s", "h", "c"].some((p) => u.searchParams.has(p));
        })
        .toBe(false);

      // After reset, all quality tiers are ticked again.
      await expect(
        page.getByRole("checkbox", { name: /^very poor$/i }),
      ).toBeChecked();
    } finally {
      await context.close();
    }
  });

  test("T16/T17/T25: anonymous riders can open a segment detail sidebar with trend and reviews", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");
      await expect(
        page.getByRole("heading", { name: /^filters$/i }),
      ).toBeVisible();

      await selectMockRoadSegment(page);

      const dialog = page.getByRole("dialog", {
        name: /road segment details/i,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Mock Ridge Road").first()).toBeVisible();
      await expect(dialog.getByText("4.6").first()).toBeVisible();
      await expect(dialog.getByText(/37 passes/i)).toBeVisible();
      await expect(
        dialog.getByText(/loose gravel after the bend/i),
      ).toBeVisible();
      await expect(
        dialog.getByTestId(`segment-trend-chart-${MOCK_ROAD_SEGMENT_ID}`),
      ).toBeVisible();
      await expect(
        dialog.getByText(/fast surface with clean sight lines/i),
      ).toBeVisible();
      await expect(
        dialog.getByText(/sign in to rate this road/i),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("T26: authenticated riders can submit a review from the segment sidebar", async ({
    authedPage,
  }) => {
    await authedPage.goto("/explore");
    await expect(
      authedPage.getByRole("heading", { name: /^filters$/i }),
    ).toBeVisible();

    await selectMockRoadSegment(authedPage);

    const dialog = authedPage.getByRole("dialog", {
      name: /road segment details/i,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /write a review/i }).click();
    await dialog.getByRole("button", { name: /^5 stars$/i }).click();
    await dialog
      .getByLabel(/^comment$/i)
      .fill("Fresh E2E review: clean asphalt and a great rhythm.");
    await dialog.getByLabel(/bike model/i).fill("Honda Transalp");
    await dialog.getByRole("button", { name: /submit review/i }).click();

    await expect(
      dialog.getByText(/fresh e2e review: clean asphalt/i),
    ).toBeVisible();
    await expect(dialog.getByText(/this is your review/i)).toBeVisible();
  });

  // T19 — surface type filter writes to `?s=...` and unticks the
  // corresponding checkbox. The chip set lives next to the quality
  // chips in the side panel and uses the same checkbox pattern.
  test("T19: unticking a surface type mirrors the URL with ?s=...", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");

      // Scope by the section heading — `Gravel` appears as both a surface
      // and a hazard label, so a page-wide `getByRole("checkbox", …)`
      // would be ambiguous.
      const surfaceSection = page
        .getByRole("heading", { name: /^surface type$/i })
        .locator("..");
      const gravel = surfaceSection.getByRole("checkbox", {
        name: /^gravel$/i,
      });
      await expect(gravel).toBeChecked();
      expect(new URL(page.url()).searchParams.has("s")).toBe(false);

      await toggleFilter(gravel);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("s"))
        .toBe("asphalt,concrete,cobblestone,dirt");
      await expect(gravel).not.toBeChecked();
    } finally {
      await context.close();
    }
  });

  // T21 — URL round-trip: filters set on one tab survive a reload. This
  // is the inverse of the existing hydration test (which only loads
  // with params); here we set, reload, and re-read.
  test("T21: filters set on the URL survive a reload", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");

      // Untick "Very poor" — should write q=excellent,good,fair,poor.
      const veryPoor = page.getByRole("checkbox", { name: /^very poor$/i });
      await toggleFilter(veryPoor);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("q"))
        .toBe("excellent,good,fair,poor");

      // Reload the page; the filter state must be restored from the URL.
      await page.reload();
      await expect(
        page.getByRole("checkbox", { name: /^very poor$/i }),
      ).not.toBeChecked();
      await expect(
        page.getByRole("checkbox", { name: /^excellent$/i }),
      ).toBeChecked();
    } finally {
      await context.close();
    }
  });

  // T22 — hazard type filter: unticking a hazard writes `?h=...`. The
  // doc-level "click a marker for type/reporter/time" step requires
  // map-interaction infrastructure that doesn't ship to the public
  // explorer; covering the filter affordance is the testable slice.
  test("T22: unticking a hazard type mirrors the URL with ?h=...", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/explore");

      expect(new URL(page.url()).searchParams.has("h")).toBe(false);

      // Scope by the "Hazard type" heading — same `Gravel` label collides
      // with the surface filter above.
      const hazardSection = page
        .getByRole("heading", { name: /^hazard type$/i })
        .locator("..");
      const pothole = hazardSection.getByRole("checkbox", {
        name: /^pothole$/i,
      });
      await expect(pothole).toBeChecked();
      await toggleFilter(pothole);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("h"))
        .toBe("gravel,oil_spill,roadworks,animals,police,flooding,ice,other");
    } finally {
      await context.close();
    }
  });
});
