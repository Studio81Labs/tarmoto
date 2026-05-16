import { test, expect } from "../fixtures";

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tarmoto E2E" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Beskydy weekend</name>
    <trkseg>
      <trkpt lat="49.524" lon="18.351"></trkpt>
      <trkpt lat="49.531" lon="18.376"></trkpt>
      <trkpt lat="49.547" lon="18.402"></trkpt>
      <trkpt lat="49.563" lon="18.421"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

test.describe("trip planner extras", () => {
  // T9 — GPX import: clicking "Import GPX" opens the import dialog;
  // setting a GPX file parses client-side and surfaces an "Adopt as
  // trip draft" CTA. Adopting writes to the trip store so the
  // planner sidebar/timeline can mount against the imported route.
  // The parse is entirely client-side (no backend round-trip), so
  // the test only needs the planner UI + a sample GPX buffer.
  test("T9: importing a GPX file adopts it as a trip draft", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");

    await page.getByRole("button", { name: /import gpx/i }).click();

    const dialog = page.getByRole("dialog", { name: /import gpx or kml/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The dialog's `<input type="file">` is hidden but Playwright's
    // `setInputFiles` triggers the same change event the IdlePicker
    // button would fire on click. Set a sample GPX buffer so the
    // parse path runs end-to-end without filesystem fixtures.
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "beskydy-weekend.gpx",
      mimeType: "application/gpx+xml",
      buffer: Buffer.from(SAMPLE_GPX, "utf-8"),
    });

    // The "Adopt" button only appears once the parse has settled
    // into the ready state — asserting on it doubles as proof the
    // parser accepted the file.
    const adoptBtn = dialog.getByRole("button", {
      name: /adopt as trip draft/i,
    });
    await expect(adoptBtn).toBeVisible({ timeout: 10_000 });
    await adoptBtn.click();

    // Dialog closes on adopt; the planner sidebar now shows the
    // imported trip name (the GPX `<name>` element). Use a substring
    // match so a future title-format tweak doesn't false-fail.
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(page.getByText(/beskydy weekend/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  // T10 — GPX export: with a generated trip loaded, the export menu
  // exposes "Download GPX" which builds the file client-side and
  // fires `link.click()` against a Blob URL. Playwright's
  // `page.waitForEvent("download")` captures the resulting download
  // intent so we can assert on the suggested filename without
  // needing to touch the filesystem.
  test("T10: Export → Download GPX triggers a .gpx download", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips/planner");
    await page.getByRole("button", { name: /load demo trip/i }).click();
    await page.getByRole("button", { name: /generate itinerary/i }).click();

    // Wait for `tripId` in the URL to confirm the planner has a
    // saved trip (the export menu disables itself until a trip is
    // loaded; without this we race the menu-disabled state).
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tripId"), {
        timeout: 10_000,
      })
      .not.toBeNull();

    await page.getByRole("button", { name: /^export$/i }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10_000 }),
      page.getByRole("menuitem", { name: /download gpx/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.gpx$/i);
  });

  // T14 — Print: `/trips/[tripId]/print` renders a printer-friendly
  // body without app chrome. Save a generated demo trip via the
  // planner (same flow as T6) so we have a real id, then open the
  // print URL in a **fresh page** within the same authenticated
  // context. The fresh page is the operational signal: production
  // export menu opens the print URL via `window.open(..., "noopener")`,
  // which severs the creator and starts the new tab with an empty
  // Zustand store — exactly the AuthSync race the bundled
  // production fix addresses. Reusing the original page keeps the
  // store warm and would let the gate silently regress without
  // failing the test.
  test("T14: /trips/:id/print renders the printer-friendly view in a new tab", async ({
    authedPage: page,
    context,
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

    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/trips/${tripId}$`));

    // Fresh page in the same context: NextAuth's session cookie
    // carries over so AuthSync can re-hydrate, but the Zustand
    // auth-store starts empty — exercises the gate the
    // production fix adds to the print page's fetch effect.
    const printPage = await context.newPage();
    try {
      await printPage.goto(`/trips/${tripId}/print`);
      await expect(
        printPage.getByRole("heading", { level: 1, name: /alps loop/i }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await printPage.close();
    }
  });
});
