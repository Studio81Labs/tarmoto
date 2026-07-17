import { test, expect } from "../fixtures";

// Simulate an EU rider: Czech browser locale, Prague timezone. Playwright
// sets both on the browser context, so navigator.language and
// Intl.DateTimeFormat().resolvedOptions().timeZone report these values.
test.use({ locale: "cs-CZ", timezoneId: "Europe/Prague" });

test.describe("format preferences autodetection", () => {
  test("captures device locale and timezone into cookies without a refresh loop", async ({
    authedPage: page,
  }) => {
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });

    await page.goto("/rides");

    // Next.js's `response.cookies.set()` percent-encodes cookie values
    // (`encodeURIComponent`), so "Europe/Prague" is stored on the wire as
    // "Europe%2FPrague". Every real consumer decodes it back — the server
    // via `cookies().get()?.value` (default `cookie` package decode) and
    // the client via FormatPrefsSync's own `readCookie()` helper
    // (`decodeURIComponent`) — so decode here too rather than comparing
    // against the raw wire value Playwright's CDP-backed cookie jar
    // returns.
    await expect
      .poll(
        async () => {
          const cookies = await page.context().cookies();
          const raw = cookies.find(
            (c) => c.name === "tarmoto-format-locale",
          )?.value;
          return raw === undefined ? raw : decodeURIComponent(raw);
        },
        { timeout: 10_000 },
      )
      .toBe("cs-CZ");

    const cookies = await page.context().cookies();
    const rawTimezone = cookies.find(
      (c) => c.name === "tarmoto-timezone",
    )?.value;
    expect(
      rawTimezone === undefined ? rawTimezone : decodeURIComponent(rawTimezone),
    ).toBe("Europe/Prague");

    // The sync must settle: navigating again with matching cookies fires
    // no further POST (a refresh loop would keep hitting the route).
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/format-prefs")) {
        posts.push(request.url());
      }
    });
    await page.goto("/rides");
    await page.waitForLoadState("networkidle");
    expect(posts).toHaveLength(0);

    expect(hydrationErrors).toEqual([]);
  });

  test("units toggle persists to the account", async ({ authedPage: page }) => {
    await page.goto("/settings/profile");

    // PreferencesSync fires its own reconciliation PATCH (format prefs) on
    // load — filter for the toggle's PATCH by its `units` payload.
    //
    // The radio is a real `<input type="radio" class="sr-only">` nested in
    // a clickable `<label>` (same pattern as the "avoid motorways" checkbox
    // in trip-planner.spec.ts) — the visually-hidden input's hit box sits
    // under the label's painted content, so a plain `.click()` times out
    // with "<label> intercepts pointer events". `force: true` is this
    // repo's established fix for that pattern; the native label→control
    // click-forwarding still fires the input's `onChange`.
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/users/me") &&
          r.method() === "PATCH" &&
          (r.postData() ?? "").includes('"units"'),
        { timeout: 10_000 },
      ),
      page.getByRole("radio", { name: /imperial/i }).click({ force: true }),
    ]);

    const payload = JSON.parse(request.postData() ?? "{}");
    expect(payload.preferences?.units).toBe("imperial");
  });

  test("renders localized numbers and dates for a cs-CZ rider", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedRide(user, {
      name: "Localized ride",
      distance_km: 1234.5,
      started_at: "2025-04-18T22:30:00Z",
    });

    await page.goto("/rides");
    await expect(page.getByText("Localized ride")).toBeVisible();

    // cs-CZ decimal comma + grouping ("1 234,5") — the visible payoff of
    // the whole migration (RidesTable's KM column renders
    // `format.splitDistanceKm(...).value`). The character class tolerates
    // the grouping separator ICU actually emits across Node/browser
    // versions: NBSP (U+00A0), narrow no-break space (U+202F), or a plain
    // ASCII space/`\s` match.
    await expect(page.getByText(/1[  \s]234,5/).first()).toBeVisible();

    // 22:30Z on Apr 18 is Apr 19 in Prague (CEST, UTC+2) — viewer-timezone
    // day shift. RidesTable's DATE column renders `format.shortDate(...)`,
    // which for cs-CZ is day-then-numeric-month with trailing periods
    // ("19. 4."); allow the dateStyle-medium "19. 4. 2025" shape too in case
    // the locator matches a different surface.
    await expect(
      page.getByText(/19\.\s*4\.|19\. 4\. 2025/).first(),
    ).toBeVisible();
  });
});
