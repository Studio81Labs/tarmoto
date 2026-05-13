import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

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
      await veryPoor.uncheck();
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
});
