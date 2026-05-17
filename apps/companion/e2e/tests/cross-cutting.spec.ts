import { test, expect } from "../fixtures";

test.describe("cross-cutting", () => {
  // T59 — Logo clickable: clicking the topbar logo (the `<Link href="/">`
  // with `aria-label="Tarmoto"`) from anywhere in the app navigates back
  // to the dashboard root.
  test("T59: logo click routes to the dashboard", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips");
    await expect(page).toHaveURL(/\/trips$/);

    await page
      .getByRole("link", { name: /^tarmoto$/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/$|\?/, { timeout: 5_000 });
  });

  // T60 — Logout: clicking "Log out" inside the user menu calls
  // `signOut({ callbackUrl: "/login" })` and the rider lands on the
  // login page with their session cleared.
  //
  // Shell v2 (#566) gives the dropdown proper menu semantics —
  // `role="menu"` on the panel, `role="menuitem"` on the entries —
  // so Playwright exposes the entries as `menuitem` instead of the
  // underlying native `link`/`button` roles.
  test("T60: logging out routes back to /login", async ({
    authedPage: page,
    user,
  }) => {
    await page.goto("/");
    // The user menu trigger is the button containing the rider's
    // display name; open it before the menu items become reachable.
    await page
      .getByRole("button", { name: new RegExp(user.displayName, "i") })
      .click();
    await page.getByRole("menuitem", { name: /^log out$/i }).click();
    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
  });

  // T61 — User menu dropdown: opening the avatar/name button reveals
  // Settings + Log out entries.
  test("T61: user menu exposes Settings + Log out", async ({
    authedPage: page,
    user,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: new RegExp(user.displayName, "i") })
      .click();
    await expect(
      page.getByRole("menuitem", { name: /^settings$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /^log out$/i }),
    ).toBeVisible();
  });

  // T62 — Notification bell: clicking the bell opens the dropdown.
  // The mock seeds an empty `inAppNotifications` map per user, so
  // we exercise the empty-state branch. T62 in the doc accepts
  // "Shows recent notifications or marks as read" — the open
  // dropdown is the contract.
  test("T62: notification bell opens its dropdown", async ({
    authedPage: page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /notifications/i }).click();
    // The dropdown carries the "Notification settings" affordance —
    // a stable signal that the panel mounted regardless of unread
    // state. (The bell itself is `aria-label="Notifications"`; the
    // settings link is `aria-label="Notification settings"`.)
    await expect(
      page.getByRole("link", { name: /notification settings/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  // T63 — Active nav highlighting: a sub-route inside one of the
  // top-level sections should mark that section's nav item active
  // via `aria-current="page"`, and no sibling section should claim
  // the active state at the same time.
  //
  // Shell v2 (#568) dropped `/settings` from the sidebar nav — it
  // lives only in the user menu now, so the original /settings/bikes
  // scenario no longer maps to a sidebar item. Re-aiming the test at
  // `/rides/road-map`, a deep child of the still-top-level "Ride
  // History" item, exercises the same parent-highlight contract.
  test("T63: sub-route highlights the parent nav item only", async ({
    authedPage: page,
  }) => {
    await page.goto("/rides/road-map");
    await expect(
      page.getByRole("link", { name: "Ride History", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("link", { name: "Trips", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  // T64 (sidebar collapse on phone viewport) is **blocked**: the
  // current `Sidebar` ships at a fixed `w-[220px]` with no
  // viewport-based collapse — there's no hamburger affordance or
  // `md:hidden` toggle in `src/components/Sidebar.tsx`. Asserting
  // anything at 390px would either pass trivially (sidebar still
  // visible) or test code that doesn't exist. Tracked as a product
  // gap; the test should land alongside the responsive sidebar work.

  // T65 — Mobile browser: opening the app at a phone viewport
  // shouldn't introduce horizontal overflow. The body's scrollWidth
  // should fit inside the viewport.
  test("T65: phone viewport has no horizontal overflow", async ({
    authedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // Allow the page to finish laying out before measuring.
    await expect(
      page.getByRole("button", { name: /notifications/i }),
    ).toBeVisible({ timeout: 10_000 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    // Allow a 1px tolerance for sub-pixel rendering on Linux Chromium.
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  // T66 + T67 — Offline indicator + reconnect: when the browser
  // goes offline the sidebar mounts an indicator chip (lives in the
  // sidebar footer alongside the notification bell since shell v2);
  // when it reconnects the indicator disappears. Playwright's
  // `context.setOffline` fires the same `online`/`offline` events
  // the component listens to.
  test("T66/T67: offline indicator surfaces and clears on reconnect", async ({
    authedPage: page,
    context,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /notifications/i }),
    ).toBeVisible({ timeout: 10_000 });

    await context.setOffline(true);
    // The indicator label cycles between "Offline" (browser-level)
    // and "Reconnecting…" / "Realtime paused" (socket-level). Match
    // any of them — the contract is "something surfaces".
    await expect(
      page.getByText(/^(Offline|Reconnecting…|Realtime paused)$/i),
    ).toBeVisible({ timeout: 5_000 });

    await context.setOffline(false);
    // Indicator dismisses after `online` fires. Allow time for the
    // realtime socket to reconnect too (otherwise the badge might
    // linger as "Reconnecting…").
    await expect(
      page.getByText(/^(Offline|Reconnecting…|Realtime paused)$/i),
    ).toBeHidden({ timeout: 15_000 });
  });

  // T68 — Deep link auth: pasting a deep URL while logged out
  // bounces through /login with `callbackUrl=…` and lands on the
  // original deep URL after login. The first half is covered by
  // auth.spec.ts; this extends to verify the round-trip.
  test("T68: deep-link bounces through login and lands on the target", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    const seeded = await mockApi.seedUser();
    // Use a trip id we know the rider can reach. The seed user owns
    // no trips yet, so a `/trips` deep link is plenty for the redirect
    // round-trip — the rider's /trips list is empty but reachable.
    await page.goto("/trips");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Ftrips/, {
      timeout: 10_000,
    });

    await page.getByPlaceholder("rider@example.com").fill(seeded.email);
    await page.locator('input[type="password"]').fill(seeded.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // After login the user should land on `/trips`, not the
    // dashboard root — Auth.js honours `callbackUrl` for relative
    // paths.
    await expect(page).toHaveURL(/\/trips(\?|$)/, { timeout: 15_000 });
  });

  // T69 — 404 page: navigating to an unknown route renders the
  // custom not-found shell with a heading and a "Go home" link.
  test("T69: unknown route renders the custom 404", async ({
    authedPage: page,
  }) => {
    await page.goto("/this-route-does-not-exist", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: /road not found/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^go home$/i })).toBeVisible();
  });

  // T70 — SEO metadata: the public `/roads/best/:country/:region`
  // page sets `<title>`, a meta description, and an `og:image`.
  // Catches a regression in `generateMetadata` for the SEO surface.
  test("T70: /roads/best/cz/beskydy ships meta description + og:image", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/roads/best/cz/beskydy");

      // Title already gated by T23; here we focus on description +
      // og:image which only show up via `generateMetadata`.
      const description = await page
        .locator('meta[name="description"]')
        .getAttribute("content");
      expect(description ?? "").toMatch(/Beskydy/i);

      const ogImage = await page
        .locator('meta[property="og:image"]')
        .getAttribute("content");
      expect(ogImage ?? "").toMatch(/^https?:\/\//);
    } finally {
      await context.close();
    }
  });
});
