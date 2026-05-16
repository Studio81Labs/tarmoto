import { test, expect } from "../fixtures";

test.describe("account & settings", () => {
  // T50 — Profile edit: changing the display name on /settings
  // PATCHes /api/v1/users/me. Assert the request body carries
  // the new name, the page surfaces the "Saved" badge, and the
  // form field retains the new value (proves the save round-
  // tripped without React reverting the input).
  test("T50: display-name update saves through the PATCH endpoint", async ({
    authedPage: page,
    user,
  }) => {
    await page.goto("/settings");

    // The label copy is "Display name " (trailing space from
    // `t()`), so target by id rather than a brittle `^…$` regex.
    const nameField = page.locator("#settings-display-name");
    // Wait for the field to render with the seeded display name —
    // the page hydrates `displayName` from `useAuthStore` after
    // mount via a `useEffect`, and filling earlier lets that
    // late-firing effect blank the test's value back to the
    // server-side seed.
    await expect(nameField).toHaveValue(user.displayName, {
      timeout: 10_000,
    });

    await nameField.fill("Adam the Rider");

    const [patchReq] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().endsWith("/users/me") && r.method() === "PATCH",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);
    const body = JSON.parse(patchReq.postData() ?? "{}");
    expect(body.display_name).toBe("Adam the Rider");

    // Success affordance — the success copy is "Saved " (trailing
    // space from `t()`), so use a substring match.
    await expect(
      page.getByRole("status").filter({ hasText: /saved/i }),
    ).toBeVisible({ timeout: 5_000 });

    // The form input itself reflects the saved value (input
    // `value` is what the test typed; this verifies React state
    // hasn't reverted) — and asserting on the on-screen field
    // sidesteps timing on the sidebar/AppShell re-paint.
    await expect(page.locator("#settings-display-name")).toHaveValue(
      "Adam the Rider",
    );
  });

  // T52 — Set active bike: the bikes list shows a "Set active"
  // button next to non-active bikes. Clicking it PATCHes the
  // bike with `is_active: true`; the mock then flips the active
  // flag across the list. Seed two bikes through the mock
  // backend so the test exercises the swap rather than the
  // new-bike-only path.
  test("T52: 'Set active' on an inactive bike flips the active flag", async ({
    authedPage: page,
    user,
    request,
  }) => {
    const mockBackendUrl = `http://127.0.0.1:${
      process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311
    }`;
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    // First bike lands active (mock's "empty list" predicate);
    // explicit `is_active: false` keeps the second inactive.
    await request.post(`${mockBackendUrl}/api/v1/account/bikes`, {
      headers: auth,
      data: { make: "Yamaha", model: "MT-09", year: 2023 },
    });
    await request.post(`${mockBackendUrl}/api/v1/account/bikes`, {
      headers: auth,
      data: {
        make: "Honda",
        model: "Africa Twin",
        year: 2024,
        is_active: false,
      },
    });

    await page.goto("/settings/bikes");

    await expect(page.getByRole("heading", { name: /my bikes/i })).toBeVisible({
      timeout: 10_000,
    });

    // Yamaha is the first-created so it lands active. Click "Set
    // active" on the Honda — the aria-label format is
    // `Set <make> <model> as active` (see `formatBikeTitle` —
    // no year).
    const setActiveBtn = page.getByRole("button", {
      name: /set Honda Africa Twin as active/i,
    });
    await expect(setActiveBtn).toBeVisible();

    const [patchReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          /\/account\/bikes\/[0-9a-f-]+/.test(r.url()) &&
          r.method() === "PATCH",
        { timeout: 10_000 },
      ),
      setActiveBtn.click(),
    ]);
    const body = JSON.parse(patchReq.postData() ?? "{}");
    expect(body.is_active).toBe(true);

    // After the PATCH resolves the list re-renders: Honda's "Set
    // active" button disappears and Yamaha's appears. Asserting
    // both prevents a false-pass on a UI that flips one direction
    // without un-flipping the other.
    await expect(
      page.getByRole("button", { name: /set Honda Africa Twin as active/i }),
    ).toBeHidden({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /set Yamaha MT-09 as active/i }),
    ).toBeVisible();
  });

  // T56 — Data export: clicking "Request export" POSTs to
  // /api/v1/account/data-export and the mock returns
  // `status: "ready"` immediately with a download URL. The page
  // surfaces a "Download your data" link as soon as the
  // resolution comes back; assert the link appears + carries a
  // non-empty href.
  test("T56: requesting a data export surfaces a download link", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings/data");

    await expect(
      page.getByRole("heading", { name: /download my data/i }),
    ).toBeVisible({ timeout: 10_000 });

    const [postRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/account/data-export") &&
          r.request().method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /request export/i }).click(),
    ]);
    // Mock returns 202 ready immediately (matches the production
    // OpenAPI contract); the page maps that into the `ready`
    // state without polling.
    expect([200, 202]).toContain(postRes.status());
    const body = (await postRes.json()) as {
      status: string;
      downloadUrl: string;
    };
    expect(body.status).toBe("ready");
    expect(body.downloadUrl).toMatch(/https?:\/\/.+/);

    // The download element is an `<a>` overridden with
    // `role="status"` so screen readers announce it as a live
    // region (it appears asynchronously after the request
    // resolves). Match by role+name accordingly.
    const downloadLink = page
      .getByRole("status")
      .filter({ hasText: /download your data/i });
    await expect(downloadLink).toBeVisible({ timeout: 5_000 });
    await expect(downloadLink).toHaveAttribute("href", /https?:\/\/.*\.zip$/);
  });
});
