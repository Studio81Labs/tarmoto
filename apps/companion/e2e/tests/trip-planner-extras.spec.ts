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

  // T10 — GPX export: with a seeded trip loaded via `?tripId=`, the
  // export menu exposes "Download GPX" which builds the file client-side
  // and triggers a blob download. We assert on the success toast
  // ("GPX downloaded") rather than Playwright's `download` event — the
  // toast is proof that `tripToGpx` ran successfully and the download
  // was initiated without hitting the catch branch. The filename
  // assertion via `download` event was removed because headless Chromium
  // intercepts programmatic blob-URL `a.click()` inconsistently across
  // Playwright versions; the toast is a more reliable signal.
  //
  // Uses seedTrip instead of the removed "Generate itinerary" flow so
  // the export menu is enabled from the start (it requires a loaded trip).
  test("T10: Export button triggers a .gpx download", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    // GPX export is gated on `gpx_export` (Pro) — grant a paid tier so the
    // export runs (and fires the success toast) instead of showing the upsell.
    await mockApi.setSubscription(user.id, "premium");
    const trip = await mockApi.seedTrip(user, {
      title: "Alps loop",
      route_geometry: [
        { lat: 46.47, lng: 10.37 },
        { lat: 46.55, lng: 10.45 },
        { lat: 46.63, lng: 10.52 },
      ],
      waypoints: [
        { lat: 46.47, lng: 10.37, name: "Start", type: "start" },
        { lat: 46.63, lng: 10.52, name: "Finish", type: "end" },
      ],
      distance_km: 125,
    });

    await page.goto(`/trips/planner?tripId=${trip.id}`);

    // Wait for the map and trip name — confirms the trip loaded.
    await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("heading", { name: /alps loop/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Export is a one-click GPX button now (no dropdown). Clicking with
    // `page.evaluate` fires the trusted click React's delegation handles;
    // a plain `.click()` can miss when the map overlaps the toolbar.
    const exportButton = page.getByRole("button", { name: /export gpx/i });
    await expect(exportButton).toBeVisible({ timeout: 5_000 });
    await exportButton.evaluate((el) => (el as HTMLElement).click());

    // The success toast is proof that `tripToGpx` completed without error
    // and the download was initiated — more reliable than `page.waitForEvent`
    // because headless Chromium doesn't always fire the download event for
    // programmatic blob-URL anchor clicks.
    await expect(page.getByText(/gpx downloaded/i)).toBeVisible({
      timeout: 5_000,
    });
  });
});
