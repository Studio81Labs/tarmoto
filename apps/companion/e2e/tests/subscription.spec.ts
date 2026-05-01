import { test, expect } from "../fixtures";

test.describe("subscription", () => {
  test("a free rider's upgrade-to-Premium flow hits Stripe Checkout with tier=premium", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings/subscription");
    await expect(
      page.getByRole("heading", { name: /subscription/i }),
    ).toBeVisible();

    // Premium card's CTA initiates Stripe Checkout. We intercept the
    // checkout API call so the test can both confirm tier=premium was
    // sent AND short-circuit the (necessarily unreachable) Stripe URL
    // before the browser tries to follow it.
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/account/subscription/checkout") &&
          r.method() === "POST",
        { timeout: 10_000 },
      ),
      // The premium card's button is named "Upgrade" when current is free.
      page
        .getByRole("article")
        .filter({ hasText: /^Premium/ })
        .getByRole("button", { name: /upgrade|select premium/i })
        .first()
        .click(),
    ]);

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.tier).toBe("premium");
  });

  test("a Premium rider can open the Stripe customer portal from the top-level button", async ({
    authedPage: page,
    user,
    mockApi,
  }) => {
    await mockApi.setSubscription(user.id, "premium");
    await page.goto("/settings/subscription");

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/account/subscription/portal") &&
          r.method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /open billing portal/i }).click(),
    ]);

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.flow ?? "manage").toBe("manage");
  });

  test("update-payment-method routes to the Stripe portal with flow=payment_method_update", async ({
    authedPage: page,
    user,
    mockApi,
  }) => {
    await mockApi.setSubscription(user.id, "premium");
    await page.goto("/settings/subscription");

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/account/subscription/portal") &&
          r.method() === "POST",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /update payment method/i }).click(),
    ]);

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.flow).toBe("payment_method_update");
  });

  test("cancel-subscription opens the retention dialog and dispatches a portal cancel flow", async ({
    authedPage: page,
    user,
    mockApi,
  }) => {
    await mockApi.setSubscription(user.id, "premium");
    await page.goto("/settings/subscription");

    // Open the cancellation dialog.
    await page
      .getByRole("button", { name: /cancel subscription/i })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/account/subscription/portal") &&
          r.method() === "POST",
        { timeout: 10_000 },
      ),
      // The retention dialog's CTA reuses the "Open billing portal"
      // wording but routes through the subscription_cancel flow.
      page
        .getByRole("dialog")
        .getByRole("button", { name: /open billing portal/i })
        .click(),
    ]);

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.flow).toBe("subscription_cancel");
  });
});
