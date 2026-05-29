import { test, expect } from "../fixtures";

test.describe("community read path", () => {
  // T37 — Community feed: /community renders a paginated feed of
  // shared rides. The mock returns an empty feed by default and the
  // page has no active filters, so the v2 spec's pristine empty
  // state ("Quiet on the feed") surfaces under the shared
  // "Community" heading. Asserting both proves the feed page
  // mounted and consumed the wire shape.
  test("T37: /community renders the feed shell + empty state", async ({
    authedPage: page,
  }) => {
    await page.goto("/community");

    await expect(
      page.getByRole("heading", { level: 1, name: /^community$/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/quiet on the feed/i)).toBeVisible();
  });

  // T39 — Collections list: /community/collections shows the rider's
  // collections. The mock returns an empty `/collections/me` list, so
  // the page surfaces the "No collections yet" empty state below the
  // shared "Community" heading (both Community section roots now
  // unify under the same h1 per the v2 spec).
  test("T39: /community/collections renders the list shell + empty state", async ({
    authedPage: page,
  }) => {
    await page.goto("/community/collections");

    await expect(
      page.getByRole("heading", { level: 1, name: /^community$/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/no collections yet/i)).toBeVisible();
  });

  // T40 — Collection detail: clicking a collection routes to
  // `/community/collections/[id]` and the page surfaces the title +
  // empty-routes hint. Seed a collection so the detail fetch has
  // something to resolve.
  test("T40: /community/collections/[id] renders the seeded collection", async ({
    authedPage: page,
    mockApi,
    user,
  }) => {
    const collection = await mockApi.seedCollection(user, {
      title: "Tatra Twisties",
      visibility: "private",
    });

    await page.goto(`/community/collections/${collection.id}`);

    await expect(
      page.getByRole("heading", { level: 1, name: /tatra twisties/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  // T41 — Shared collection: a public-or-unlisted collection is
  // reachable at `/community/collections/shared/[slug]` without
  // auth. Use a fresh `browser.newContext()` so the test
  // explicitly exercises the anonymous path. The mock binds the
  // slug to the seeded collection via `state.collectionsBySlug`.
  test("T41: /community/collections/shared/:slug renders publicly", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    // The shared route needs an owner so the response can echo their
    // display name; seed a user first.
    const owner = await mockApi.seedUser();
    const collection = await mockApi.seedCollection(owner, {
      title: "Public Best of CZ",
      visibility: "public",
      slug: "public-best-cz",
    });

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`/community/collections/shared/${collection.slug}`);

      await expect(
        page.getByRole("heading", { level: 1, name: /public best of cz/i }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  // T44 — Achievements: /achievements renders the achievements
  // shell. Full snapshot rendering would require mocking five extra
  // endpoints (`/users/:id/badges`, `/challenges`, `/users/me/profile`,
  // `/challenges/:id`, `/leaderboards/regional`). For this read-path
  // pass we just assert the page mounts under the "Achievements"
  // heading — the per-section assertions (Badges / Active challenges
  // / Leaderboards) land alongside the snapshot mock in a follow-up.
  //
  // The route renamed from `/gamification` to `/achievements` in the
  // v2-Full migration (the lib stays `@/lib/gamification` since that
  // is the domain model name; only the URL path changed).
  test("T44: /achievements renders the achievements heading", async ({
    authedPage: page,
  }) => {
    await page.goto("/achievements");
    await expect(
      page.getByRole("heading", { level: 1, name: /achievements/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
