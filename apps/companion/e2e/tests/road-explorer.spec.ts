import { test, expect } from "../fixtures";

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
});
