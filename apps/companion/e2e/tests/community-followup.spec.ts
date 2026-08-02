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
    // A freshly seeded rider doesn't follow the viewer, so no badge.
    await expect(page.getByText("Follows you")).toHaveCount(0);
  });

  // T38b — "Follows you" badge: when the target rider follows the
  // signed-in viewer back, the profile header surfaces the incoming-
  // follow affordance (driven by the `follows_you` wire field).
  test("T38b: /community/[riderId] shows the 'Follows you' badge for an incoming follow", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const target = await mockApi.seedUser({ displayName: "Mutual Rider" });
    // Target → viewer follow edge.
    await mockApi.seedFollow(target.id, user.id);

    await page.goto(`/community/${target.id}`);

    await expect(
      page.getByRole("heading", { level: 1, name: /mutual rider/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Follows you")).toBeVisible();
  });

  // T46 — Profile stats + shared rides: the v2 rider profile surfaces
  // backend-derived lifetime distance, public-share count, and the shared
  // rides table. Seed a target rider with a completed ride + a public share,
  // then assert the Distance hero tile, the "Rides shared" tile, and the
  // shared-rides row all reflect that data.
  test("T46: /community/[riderId] renders v2 stats + shared rides from real data", async ({
    authedPage: page,
    mockApi,
  }) => {
    const target = await mockApi.seedUser({ displayName: "Mira Hajkova" });
    const ride = await mockApi.seedRide(target, {
      name: "Stelvio Loop",
      distance_km: 180,
    });
    await mockApi.seedRideShare(ride.id, { is_public: true });

    await page.goto(`/community/${target.id}`);

    await expect(
      page.getByRole("heading", { level: 1, name: /mira hajkova/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Distance hero tile: lifetime km over completed rides. The unit comes
    // from `format.splitDistanceKm(...).unit` (locale-formatting migration,
    // #1012 Task 8) — Intl's CLDR short unit name for kilometres is
    // lowercase ("km"), not the pre-migration hardcoded uppercase "KM".
    const distanceTile = page
      .locator("div")
      .filter({ hasText: /^Distance/ })
      .first();
    await expect(distanceTile).toContainText("180");
    await expect(distanceTile).toContainText("km");

    // Shared-rides section reflects the one public share. The count uses an ICU
    // plural (`one {{n} public ride}`), so a count of 1 renders the SINGULAR
    // "1 public ride" — not the pluralised form.
    await expect(page.getByText("1 public ride")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /stelvio loop/i }),
    ).toBeVisible();
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
      page.getByRole("heading", { level: 1, name: /^community$/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Pristine empty state. The v2 spec-aligned empty card has no
    // inline CTA, so the toolbar "New collection" button in the
    // shared header is the only path into the modal.
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

  // T45 — Clone to trips: "Add to trips" on a community feed card clones
  // the shared ride into a fresh draft trip and routes to its detail page.
  // Seed a public shared ride (the default 2-point geometry makes it
  // clonable), click the card CTA, and assert the app lands on the new
  // trip — proving the clone POST returned a real, resolvable trip id
  // (the cloned-trip detail fetch 404s if the trip wasn't persisted).
  test("T45: Add to trips clones a community ride into a new trip", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const ride = await mockApi.seedRide(user, {
      name: "Clone Test Route",
      distance_km: 180,
    });
    await mockApi.seedRideShare(ride.id, { is_public: true });

    await page.goto("/community");

    await page
      .getByRole("button", { name: /add to trips/i })
      .first()
      .click();

    // Navigation to /trips/:id (a real UUID) proves the clone returned a
    // persisted trip; the detail heading echoes the cloned title.
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}$/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: /clone test route/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  // A publicly-shared community ride opens the real ride detail page
  // (/rides/:id) for a non-owner — read-only (no rename/compare/export),
  // with owner attribution and a back link to the community feed.
  test("T47: a community ride opens the read-only ride detail for non-owners", async ({
    authedPage: page,
    mockApi,
  }) => {
    const owner = await mockApi.seedUser({ displayName: "Trail Owner" });
    const ride = await mockApi.seedRide(owner, { name: "Stelvio Loop" });
    await mockApi.seedRideShare(ride.id, { is_public: true });

    await page.goto(`/community/rides/${ride.id}`);

    await expect(
      page.getByRole("heading", { level: 1, name: /stelvio loop/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Rename ride" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("link", { name: /Compare/i })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /Trail Owner/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Community · Feed/i }),
    ).toBeVisible();
  });
});
