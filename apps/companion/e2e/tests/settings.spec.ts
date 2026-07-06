import { test, expect } from "../fixtures";

test.describe("settings: privacy", () => {
  test("changing profile visibility persists via the save button", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings/privacy");
    await expect(
      page.getByRole("heading", { name: /privacy/i }).first(),
    ).toBeVisible();

    // Toggle profile visibility from "Riders only" (default) to "Public".
    // Scope to the radiogroup so we don't pick up the "Public" option in
    // the sibling Default-ride-sharing group.
    await page
      .getByRole("radiogroup", { name: /profile visibility/i })
      .getByRole("radio", { name: /public/i })
      .click();
    await expect(page.getByText(/unsaved changes/i)).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/account/privacy") && r.method() === "PUT",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /save preferences/i }).click(),
    ]);

    const payload = JSON.parse(request.postData() ?? "{}");
    expect(payload.profile_visibility).toBe("public");

    // Persisted state shows the "Saved" badge.
    await expect(page.getByText(/saved/i).first()).toBeVisible();
  });
});

test.describe("settings: notifications", () => {
  test("changing the email digest cadence persists via the save button", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings/notifications");
    await expect(
      page.getByRole("heading", { name: /notifications/i }).first(),
    ).toBeVisible();

    // Default is "Weekly"; switch to "Daily". The radio's accessible name
    // also includes the description ("Every morning"), so use a prefix
    // match rather than an exact regex.
    await page
      .getByRole("radiogroup", { name: /email digest frequency/i })
      .getByRole("radio", { name: /^Daily/ })
      .click();
    await expect(page.getByText(/unsaved changes/i)).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.url().includes("/me/notification-preferences") &&
          r.method() === "PUT",
        { timeout: 10_000 },
      ),
      page.getByRole("button", { name: /save preferences/i }).click(),
    ]);

    const payload = JSON.parse(request.postData() ?? "{}");
    expect(payload.email_digest).toBe("daily");
    await expect(page.getByText(/saved/i).first()).toBeVisible();
  });
});

test.describe("settings: bikes", () => {
  test("adding, editing, and deleting a bike round-trips through the API", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings/bikes");
    await expect(
      page.getByRole("heading", { name: /my bikes/i }),
    ).toBeVisible();

    // Empty garage — open the add-bike modal from the page header / CTA.
    await page
      .getByRole("button", { name: /add (bike|your first bike)/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: /add a bike/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^make$/i).fill("Yamaha");
    await dialog.getByLabel(/^model$/i).fill("MT-09");
    await dialog.getByLabel(/^year$/i).fill("2024");
    const [createReq] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().endsWith("/account/bikes") && r.method() === "POST",
        { timeout: 10_000 },
      ),
      dialog.getByRole("button", { name: /^Add bike$/i }).click(),
    ]);
    const createBody = JSON.parse(createReq.postData() ?? "{}");
    expect(createBody.make).toBe("Yamaha");
    expect(createBody.model).toBe("MT-09");
    expect(createBody.year).toBe(2024);
    expect(createBody.is_active).toBe(false);
    expect(createBody).not.toHaveProperty("isActive");

    // Card lands on the page once the modal closes and the list refreshes.
    await expect(page.getByText(/Yamaha MT-09/i).first()).toBeVisible();

    // Edit the bike — switch the model.
    await page
      .getByRole("button", { name: /edit Yamaha/i })
      .first()
      .click();
    const editDialog = page.getByRole("dialog", { name: /edit bike/i });
    await expect(editDialog).toBeVisible();
    const modelField = editDialog.getByLabel(/^model$/i);
    await modelField.fill("");
    await modelField.fill("MT-10");
    const [updateReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          /\/account\/bikes\/[0-9a-f-]+/.test(r.url()) &&
          r.method() === "PATCH",
        { timeout: 10_000 },
      ),
      editDialog.getByRole("button", { name: /save changes/i }).click(),
    ]);
    const updateBody = JSON.parse(updateReq.postData() ?? "{}");
    expect(updateBody.model).toBe("MT-10");
    expect(updateBody).not.toHaveProperty("photoUrl");
    await expect(page.getByText(/Yamaha MT-10/i).first()).toBeVisible();

    // Delete via the trash icon — system dialogs are disallowed; the
    // app-styled ConfirmDialog carries the destructive commit now.
    await page
      .getByRole("button", { name: /delete Yamaha/i })
      .first()
      .click();
    const removeDialog = page.getByRole("dialog", {
      name: /remove this bike/i,
    });
    await expect(removeDialog).toBeVisible();
    const [deleteReq] = await Promise.all([
      page.waitForRequest(
        (r) =>
          /\/account\/bikes\/[0-9a-f-]+/.test(r.url()) &&
          r.method() === "DELETE",
        { timeout: 10_000 },
      ),
      removeDialog.getByRole("button", { name: /^Remove bike$/i }).click(),
    ]);
    expect(deleteReq.method()).toBe("DELETE");

    await expect(page.getByText(/no bikes in your garage yet/i)).toBeVisible();
  });
});

test.describe("settings: account deletion", () => {
  test("the deletion confirmation flow gates on email + password", async ({
    authedPage: page,
    user,
  }) => {
    await page.goto("/settings/data");
    await expect(
      page.getByRole("heading", { name: /data .* account/i }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: /delete my account/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: /delete account permanently/i,
    });
    await expect(dialog).toBeVisible();

    const confirmButton = dialog.getByRole("button", {
      name: /^delete account$/i,
    });
    // The button is disabled until both fields match.
    await expect(confirmButton).toBeDisabled();

    await dialog.getByLabel(/your email address/i).fill(user.email);
    await expect(confirmButton).toBeDisabled(); // Still disabled — password missing.

    await dialog.getByLabel(/your password/i).fill(user.password);
    await expect(confirmButton).toBeEnabled();

    // Click confirm — the API call goes out, but the test doesn't follow
    // the post-deletion sign-out redirect (it would land back on /login,
    // which is fine but adds noise).
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().endsWith("/account") && r.method() === "DELETE",
        { timeout: 10_000 },
      ),
      confirmButton.click(),
    ]);
    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.password).toBe(user.password);
  });
});
