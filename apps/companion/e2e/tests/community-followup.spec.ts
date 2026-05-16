import { test, expect } from "../fixtures";

test.describe("community follow-up flows", () => {
  // T38 — Rider profile: /community/[riderId] mounts the public
  // profile of a different rider. The mock returns a non-self
  // PublicProfile, an empty badges list, and an empty shared-rides
  // page; the page renders the rider's display name, the Follow
  // CTA, and the badges "no badges available yet" empty state.
  test("T38: /community/[riderId] renders the rider profile + follow CTA", async ({
    authedPage: page,
    mockApi,
  }) => {
    const target = await mockApi.seedUser({ displayName: "Jana Riderka" });

    await page.goto(`/community/${target.id}`);

    await expect(
      page.getByRole("heading", { level: 1, name: /jana riderka/i }),
    ).toBeVisible({ timeout: 10_000 });
    // The mock returns `is_following: false` for a freshly seeded
    // rider, so the CTA renders as "Follow". Asserting on
    // `aria-pressed="false"` proves the page consumed the wire
    // shape — the button toggles to `aria-pressed="true"` after a
    // successful follow.
    await expect(
      page.getByRole("button", { name: /^follow$/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  // T42 — Create collection: the "New collection" button on
  // `/community/collections` opens a modal that POSTs to
  // /api/v1/collections. After submit, the new collection should
  // surface as a card with its title visible. Asserting the
  // heading + the new card title proves both the POST and the
  // optimistic-merge into the owned-grid work end-to-end.
  test("T42: New collection modal creates + lists the collection", async ({
    authedPage: page,
  }) => {
    await page.goto("/community/collections");

    await expect(
      page.getByRole("heading", { level: 1, name: /route collections/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The list is empty, so the "Create collection" empty-state
    // button (rather than the toolbar "New collection") is what
    // the rider would actually click first. Both target the same
    // modal; use the toolbar button by exact name to avoid
    // double-matching the empty-state action.
    await page.getByRole("button", { name: /^new collection$/i }).click();

    // The dialog has `role="dialog"` + `aria-labelledby` referencing
    // the heading "New collection". The Name field is labelled by
    // `htmlFor="collection-name"`.
    const dialog = page.getByRole("dialog", { name: /new collection/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^name$/i).fill("Tatra Loops");
    await dialog
      .getByLabel(/description/i)
      .fill("My favourite weekend rides through the High Tatras");
    await dialog.getByRole("button", { name: /^create$/i }).click();

    // After submit, the modal closes and the card lands in the
    // owned grid. The card heading is an h3 inside a `<Link>` —
    // assert the visible title plus the route-count empty hint
    // (`0 routes`) so a stale modal flake doesn't false-pass.
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { level: 3, name: /tatra loops/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("0 routes")).toBeVisible();
  });

  // T43 — Delete collection: from the owner's list, the card's
  // kebab menu opens a Delete action which surfaces an
  // app-styled confirmation dialog. Confirming triggers DELETE
  // /api/v1/collections/:id and removes the card from the grid.
  // Seeded collection ensures the card renders without a CRUD
  // round-trip first.
  test("T43: Delete from the card menu removes the collection", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    await mockApi.seedCollection(user, {
      title: "Beskydy Best",
      visibility: "private",
    });

    await page.goto("/community/collections");

    await expect(
      page.getByRole("heading", { level: 3, name: /beskydy best/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Open the kebab — its aria-label embeds the collection title
    // so two seeded collections wouldn't double-match.
    await page
      .getByRole("button", { name: /actions for beskydy best/i })
      .click();

    // The menu re-renders inline. Items are plain `<button>`s, so
    // target by role+name — the kebab button uses "Actions for …"
    // and the confirm dialog isn't open yet, so this matches only
    // the menu item.
    await page.getByRole("button", { name: /^delete$/i }).click();

    // ConfirmDialog (role=dialog, title="Delete collection"). The
    // dialog's Delete button is now the only one with that name in
    // scope — match it via the dialog locator to avoid any race
    // where the menu item lingers.
    const dialog = page.getByRole("dialog", { name: /delete collection/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^delete$/i }).click();

    // Optimistic removeOne() drops the row immediately on
    // resolution. Asserting the heading is gone proves the DELETE
    // round-tripped + the local cache shed the row.
    await expect(
      page.getByRole("heading", { level: 3, name: /beskydy best/i }),
    ).toBeHidden({ timeout: 5_000 });
  });
});
