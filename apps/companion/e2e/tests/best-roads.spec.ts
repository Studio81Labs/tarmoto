import { test, expect } from "../fixtures";

test.describe("best roads", () => {
  // T23 — Best Roads page: the public `/roads/best/:country/:region`
  // route SSR-fetches `/api/v1/roads/best` and renders a curated list
  // with SEO metadata. The page is anonymous-friendly and must work
  // without any auth state. We assert the heading, the ranked list,
  // and the `<title>` carry the region name so the SEO surface is
  // wired all the way through.
  test("T23: /roads/best/:country/:region renders the curated list + SEO metadata", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // `beskydy` is in the static-params list (see
      // packages/shared/src/regions.ts); the mock returns two roads
      // for any region we ask for.
      await page.goto("/roads/best/cz/beskydy");

      // SEO: the document title and `og:title` both surface the region.
      await expect(page).toHaveTitle(/Beskydy/i);
      const ogTitle = await page
        .locator('meta[property="og:title"]')
        .getAttribute("content");
      expect(ogTitle ?? "").toMatch(/Beskydy/i);

      // H1 surfaces the region name; the ranked-list section is keyed
      // by its localized heading.
      await expect(
        page.getByRole("heading", { level: 1, name: /Beskydy/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /ranked roads/i }),
      ).toBeVisible();
      // The two mock roads should both render by name.
      await expect(page.getByText(/Mock Ridge Road/i)).toBeVisible();
      await expect(page.getByText(/Sunset Climb/i)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
