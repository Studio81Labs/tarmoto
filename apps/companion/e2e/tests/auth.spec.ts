import { test, expect, loginViaUi } from "../fixtures";

test.describe("auth", () => {
  test("register → auto-login lands the rider on the skippable plan step", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `new-rider-${suffix}@example.com`;

    await page.goto("/register");
    await page.getByPlaceholder("RoadWarrior42").fill(`Rider ${suffix}`);
    await page.getByPlaceholder("rider@example.com").fill(email);
    await page.getByPlaceholder(/min\.? 8 characters/i).fill("StrongPass1!");
    await page.getByRole("button", { name: /^Create account$/i }).click();

    // #1173: the default post-registration destination is the plan step, which
    // needs the session it was just given — so this also proves the route is
    // NOT caught by the middleware's `/register` auth-page prefix.
    await page.waitForURL("**/welcome/plan", { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /choose how you ride/i }),
    ).toBeVisible();

    // Skippable: one click lands the rider on the dashboard, still on the tier
    // registration gave them.
    await page.getByRole("button", { name: /^Skip for now$/i }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
    expect(page.url()).not.toContain("/register");
    expect(page.url()).not.toContain("/login");
  });

  test("registering with a taken email surfaces the conflict", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    const seeded = await mockApi.seedUser();

    await page.goto("/register");
    await page.getByPlaceholder("RoadWarrior42").fill("Different name");
    await page.getByPlaceholder("rider@example.com").fill(seeded.email);
    await page.getByPlaceholder(/min\.? 8 characters/i).fill("StrongPass1!");
    await page.getByRole("button", { name: /^Create account$/i }).click();

    await expect(
      page.getByText(/account .* already exists/i).first(),
    ).toBeVisible();
    expect(page.url()).toContain("/register");
  });

  test("login with the right password redirects to the dashboard", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    const seeded = await mockApi.seedUser();
    await loginViaUi(page, seeded.email, seeded.password);
    expect(page.url()).not.toContain("/login");
  });

  test("login with the wrong password shows an inline error", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    const seeded = await mockApi.seedUser();

    await page.goto("/login");
    await page.getByPlaceholder("rider@example.com").fill(seeded.email);
    await page.locator('input[type="password"]').fill("not-the-password");
    await page.getByRole("button", { name: /^Sign in$/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    expect(page.url()).toContain("/login");
  });

  test("forgot-password always renders the success screen", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.getByPlaceholder("rider@example.com").fill("anyone@example.com");
    await page.getByRole("button", { name: /^Send reset link$/i }).click();

    await expect(
      page.getByRole("heading", { name: /check your email/i }),
    ).toBeVisible();
    await expect(page.getByText(/anyone@example\.com/i)).toBeVisible();
  });

  test("the auth pages cross-link for navigation", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: /forgot password/i }).click();
    await expect(page).toHaveURL(/\/forgot-password/);

    await page.getByRole("link", { name: /back to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByRole("link", { name: /create one/i }).click();
    await expect(page).toHaveURL(/\/register/);

    await page.getByRole("link", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unauthenticated visit to a private route bounces to /login with callbackUrl", async ({
    page,
    mockApi,
  }) => {
    await mockApi.reset();
    await page.goto("/trips");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Ftrips/);
  });

  // T49 — auth persistence: after a successful login, navigating to a
  // protected route and reloading must restore the session without
  // bouncing through /login again.
  test("T49: signed-in riders stay signed in across reload", async ({
    authedPage: page,
  }) => {
    await page.goto("/trips");
    await expect(page).toHaveURL(/\/trips$/);
    await page.reload();
    await expect(page).toHaveURL(/\/trips$/);
    await expect(page).not.toHaveURL(/\/login/);
  });
});
