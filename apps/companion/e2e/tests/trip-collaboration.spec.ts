import { test, expect, authenticate } from "../fixtures";

test.describe("trip collaboration", () => {
  test("two riders can round-trip a suggestion and a vote on the same trip", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const owner = await mockApi.seedUser({
      email: "owner@example.com",
      displayName: "Trip Owner",
    });
    const collaborator = await mockApi.seedUser({
      email: "collab@example.com",
      displayName: "Group Member",
    });
    // The Collaborate entry (modal + suggestions/votes) is gated on
    // `collaborative_trips` (Pro) for both the owner and the joining rider.
    await mockApi.setSubscription(owner.id, "premium");
    await mockApi.setSubscription(collaborator.id, "premium");

    const trip = await mockApi.createTrip(owner, {
      title: "Dolomites weekend",
      num_days: 2,
    });
    await mockApi.addTripMember(trip.id, collaborator.id);

    // Two isolated browser contexts simulate two riders. Cookies, auth
    // session, and Zustand state are fully separated per context.
    const ownerContext = await browser.newContext();
    const collaboratorContext = await browser.newContext();

    try {
      await authenticate(ownerContext, owner);
      await authenticate(collaboratorContext, collaborator);

      const ownerPage = await ownerContext.newPage();
      const collaboratorPage = await collaboratorContext.newPage();

      // Both riders land on the trip via the planner with `?tripId=`,
      // which is the live-collab surface. Direct navigation triggers
      // the auth-store hydration race documented in the planner; using
      // the trip list as a stepping stone avoids it.
      await ownerPage.goto("/trips");
      await ownerPage
        .getByRole("link", { name: /dolomites weekend/i })
        .first()
        .click();
      await ownerPage.waitForURL((u) => /\/trips\/[0-9a-f-]+/.test(u.pathname));
      // Planner edit handoff redirects to /trips/planner?tripId=...
      await ownerPage
        .getByRole("link", { name: /^edit$/i })
        .first()
        .click();
      await ownerPage.waitForURL((u) => u.pathname.includes("/trips/planner"));

      // Collaborator follows the same path on their context.
      await collaboratorPage.goto("/trips");
      await collaboratorPage
        .getByRole("link", { name: /dolomites weekend/i })
        .first()
        .click();
      await collaboratorPage.waitForURL((u) =>
        /\/trips\/[0-9a-f-]+/.test(u.pathname),
      );
      await collaboratorPage
        .getByRole("link", { name: /^edit$/i })
        .first()
        .click();
      await collaboratorPage.waitForURL((u) =>
        u.pathname.includes("/trips/planner"),
      );

      // Owner posts a suggestion via the Collaborate modal.
      await ownerPage.getByRole("button", { name: /^Collaborate$/i }).click();
      await expect(
        ownerPage.getByRole("dialog", { name: /collaborate on this trip/i }),
      ).toBeVisible();
      await ownerPage.getByRole("tab", { name: /suggestions/i }).click();
      await ownerPage
        .getByRole("textbox", { name: /suggestion title/i })
        .fill("Detour via Passo Giau");
      await ownerPage
        .getByRole("textbox", { name: /suggestion description/i })
        .fill("Adds a stunning hairpin section worth the extra 35 km.");
      await ownerPage
        .getByRole("button", { name: /submit suggestion/i })
        .click();

      // Suggestion shows in the owner's list.
      await expect(
        ownerPage.getByRole("heading", { name: /detour via passo giau/i }),
      ).toBeVisible({ timeout: 8_000 });

      // Collaborator does a client-side round-trip through the trip list
      // and back into the planner. WebSocket-driven live updates are
      // mocked out here (backend e2e tests cover that surface), so a
      // re-mount of the collab session is what re-triggers the
      // suggestions fetch. Going via the list rather than page.reload()
      // keeps the next-auth/Zustand state hydrated and avoids the
      // hard-reload auth-store race.
      await collaboratorPage
        .getByRole("link", { name: /^\d+\s*trips$/i })
        .click();
      await collaboratorPage.waitForURL((u) => u.pathname === "/trips");
      await collaboratorPage
        .getByRole("link", { name: /dolomites weekend/i })
        .first()
        .click();
      await collaboratorPage
        .getByRole("link", { name: /^edit$/i })
        .first()
        .click();
      await collaboratorPage.waitForURL((u) =>
        u.pathname.includes("/trips/planner"),
      );
      await collaboratorPage
        .getByRole("button", { name: /^Suggestions$/i })
        .click();
      await expect(
        collaboratorPage.getByRole("heading", {
          name: /detour via passo giau/i,
        }),
      ).toBeVisible({ timeout: 10_000 });

      // Collaborator votes up. Vote count flips from 0 to 1 in the mock,
      // and the up-vote button gets aria-pressed=true.
      const upVote = collaboratorPage.getByRole("button", { name: /vote up/i });
      await upVote.click();
      await expect(upVote).toHaveAttribute("aria-pressed", "true");
      await expect(upVote).toContainText("1");

      // Owner does the same client-side round-trip to pick up the vote.
      await ownerPage.getByRole("button", { name: /close dialog/i }).click();
      await ownerPage.getByRole("link", { name: /^\d+\s*trips$/i }).click();
      await ownerPage.waitForURL((u) => u.pathname === "/trips");
      await ownerPage
        .getByRole("link", { name: /dolomites weekend/i })
        .first()
        .click();
      await ownerPage
        .getByRole("link", { name: /^edit$/i })
        .first()
        .click();
      await ownerPage.waitForURL((u) => u.pathname.includes("/trips/planner"));
      await ownerPage.getByRole("button", { name: /^Collaborate$/i }).click();
      await ownerPage.getByRole("tab", { name: /suggestions/i }).click();
      const ownerUpVote = ownerPage.getByRole("button", { name: /vote up/i });
      await expect(ownerUpVote).toContainText("1", { timeout: 10_000 });

      // Owner accepts the suggestion. The card moves into the resolved
      // group, which starts collapsed behind the "N resolved" summary —
      // expand it to see the ACCEPTED status.
      await ownerPage.getByRole("button", { name: /^Accept$/ }).click();
      await ownerPage
        .getByRole("button", { name: /\d+ resolved/i })
        .click({ timeout: 8_000 });
      await expect(ownerPage.getByText(/^accepted$/i).first()).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await ownerContext.close();
      await collaboratorContext.close();
    }
  });

  test("public share link renders the trip without requiring auth", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const owner = await mockApi.seedUser();
    const trip = await mockApi.createTrip(owner, {
      title: "Public share test",
      num_days: 1,
    });

    // Create a share via the API directly so the test doesn't depend on
    // the (small, auth-only) UI for share creation.
    const shareRes = await fetch(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311}/api/v1/trip-shares`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${owner.accessToken}`,
        },
        body: JSON.stringify({
          title: trip.title,
          snapshot: { name: trip.title, days: [] },
          trip_id: trip.id,
        }),
      },
    );
    const share = (await shareRes.json()) as {
      share_token: string;
      share_url: string;
    };
    expect(share.share_token).toBeTruthy();

    // Anonymous browser context — no cookies, no auth session.
    const anonymous = await browser.newContext();
    try {
      const page = await anonymous.newPage();
      await page.goto(`/trips/shared/${share.share_token}`);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByText(/public share test/i).first()).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await anonymous.close();
    }
  });

  test("shared trip link lets a signed-in recipient join the planner and collaborate", async ({
    browser,
    mockApi,
  }) => {
    await mockApi.reset();
    const owner = await mockApi.seedUser({
      email: "owner-share@example.com",
      displayName: "Share Owner",
    });
    const collaborator = await mockApi.seedUser({
      email: "recipient-share@example.com",
      displayName: "Share Recipient",
    });
    // The Collaborate entry (join → suggestions/votes) is gated on
    // `collaborative_trips` (Pro) for both the owner and the recipient.
    await mockApi.setSubscription(owner.id, "premium");
    await mockApi.setSubscription(collaborator.id, "premium");
    const trip = await mockApi.createTrip(owner, {
      title: "Shared Dolomites plan",
      num_days: 2,
    });

    const shareRes = await fetch(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MOCK_BACKEND_PORT ?? 4311}/api/v1/trip-shares`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${owner.accessToken}`,
        },
        body: JSON.stringify({
          title: trip.title,
          snapshot: { name: trip.title, days: [] },
          trip_id: trip.id,
        }),
      },
    );
    const share = (await shareRes.json()) as { share_token: string };

    const ownerContext = await browser.newContext();
    const recipientContext = await browser.newContext();

    try {
      await authenticate(ownerContext, owner);

      const recipientPage = await recipientContext.newPage();
      await recipientPage.goto(`/trips/shared/${share.share_token}`);
      await recipientPage
        .getByRole("link", { name: /sign in to collaborate/i })
        .click();
      await expect(recipientPage).toHaveURL(/\/login\?callbackUrl=/);

      await recipientPage
        .getByPlaceholder("rider@example.com")
        .fill(collaborator.email);
      await recipientPage
        .locator('input[type="password"]')
        .fill(collaborator.password);
      await recipientPage.getByRole("button", { name: /^Sign in$/i }).click();
      await recipientPage.waitForURL(
        (url) => url.pathname === `/trips/shared/${share.share_token}`,
        { timeout: 15_000 },
      );

      await recipientPage.getByRole("button", { name: /join trip/i }).click();
      // Joining lands on the read-only preview (never the editor) — from
      // there the recipient opens the suggestions dialog.
      await recipientPage.waitForURL(
        (url) => url.pathname === `/trips/${trip.id}`,
        { timeout: 15_000 },
      );

      await recipientPage
        .getByRole("button", { name: /^Suggestions$/i })
        .click();
      await recipientPage
        .getByRole("textbox", { name: /suggestion title/i })
        .fill("Add the lake viewpoint");
      await recipientPage
        .getByRole("textbox", { name: /suggestion description/i })
        .fill("Good place for the whole group to regroup.");
      await recipientPage
        .getByRole("button", { name: /submit suggestion/i })
        .click();
      await expect(
        recipientPage.getByRole("heading", { name: /add the lake viewpoint/i }),
      ).toBeVisible({ timeout: 10_000 });

      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto("/trips");
      await ownerPage
        .getByRole("link", { name: /shared dolomites plan/i })
        .first()
        .click();
      await ownerPage.waitForURL((url) =>
        /\/trips\/[0-9a-f-]+/.test(url.pathname),
      );
      await ownerPage
        .getByRole("link", { name: /^edit$/i })
        .first()
        .click();
      await ownerPage.waitForURL((url) =>
        url.pathname.includes("/trips/planner"),
      );
      await ownerPage.getByRole("button", { name: /^Collaborate$/i }).click();
      await ownerPage.getByRole("tab", { name: /suggestions/i }).click();
      await expect(
        ownerPage.getByRole("heading", { name: /add the lake viewpoint/i }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await ownerContext.close();
      await recipientContext.close();
    }
  });
});
