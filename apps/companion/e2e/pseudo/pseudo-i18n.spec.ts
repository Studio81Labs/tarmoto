import type { Page } from "@playwright/test";
import { test, expect, type SeededUser } from "../fixtures";

// Pseudo-translation smoke test (#1047). Runs ONLY under
// playwright.pseudo.config.ts, whose dev server sets TARMOTO_I18N_PSEUDO=1:
// every companion catalog VALUE is served wrapped in sentinels while the
// locale stays "en" (see src/i18n/pseudo.ts).
//
// What this catches that the compiler and the ESLint guard cannot: raw
// string label maps rendered as JSX *children* — e.g.
// `const LABELS = { start: "Start" }` + `<span>{LABELS[type]}</span>`. The
// values never reach `t()` (invisible to the typed-key compiler check) and
// they are children, not attributes (invisible to the ESLint prop
// selectors). Under pseudo mode such copy renders UNWRAPPED, so asserting
// that key chrome elements ARE wrapped fails the moment one regresses.
// This class shipped once already: TripDetailSidebar's WAYPOINT_ROLE map
// ("Rest"/"Stay" unregistered) was only found by the #1044 whole-branch
// review. The planner spine assertion below pins the same label-map family.
//
// Deliberately CURATED, not a blanket "zero raw English in the DOM" scan:
// formatted numbers/units, backend/fixture data, and proper nouns
// legitimately render raw. Each assertion targets one load-bearing chrome
// element through a stable selector.
//
// The shared `authedPage`/`loginViaUi` helpers anchor on cataloged English
// copy ("Sign in", the email placeholder), which is wrapped in this suite —
// so login here drives structural selectors instead.
const PSEUDO_START = "⟦ !!! ";
const PSEUDO_END = " !!! ⟧";

/** The exact text the pseudo catalog serves for a cataloged message. */
function pseudo(message: string): string {
  return `${PSEUDO_START}${message}${PSEUDO_END}`;
}

async function loginStructurally(
  page: Page,
  user: SeededUser,
  callbackPath: string,
): Promise<void> {
  await page.goto(`/login?callbackUrl=${encodeURIComponent(callbackPath)}`);
  await page.locator("#login-email").fill(user.email);
  await page.locator("#login-password").fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

test.describe("pseudo-translation smoke", () => {
  test("login chrome and the document title come from the catalog", async ({
    page,
  }) => {
    await page.goto("/login");

    // The pseudo swap keeps the locale itself untouched — only catalog
    // values change. A "pseudo locale" leaking into <html lang> would mean
    // the swap went through LOCALES/resolveLocale, which #1047 forbids.
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    // Server-rendered metadata (src/app/layout.tsx generateMetadata) goes
    // through the request-bound server translator.
    await expect(page).toHaveTitle(pseudo("Tarmoto"));

    // Client-component children copy.
    await expect(
      page.getByRole("heading", { name: pseudo("Welcome back") }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: pseudo("Sign in") }),
    ).toBeVisible();
  });

  test("dashboard chrome and the trip status label map are pseudo-wrapped", async ({
    page,
    mockApi,
    user,
  }) => {
    const trip = await mockApi.createTrip(user, {
      title: "Alpine Sweep",
      num_days: 2,
    });

    await loginStructurally(page, user, "/trips");
    await expect(page).toHaveURL(/\/trips/);

    // Persistent chrome: the sidebar nav labels are themselves a
    // children-position label map (NAV_ITEMS → t(item.label)).
    await expect(
      page.getByRole("link", { name: pseudo("Trips") }),
    ).toBeVisible();

    // Page chrome: the PageHeader h1.
    await expect(
      page.getByRole("heading", { level: 1, name: pseudo("My Trips") }),
    ).toBeVisible();

    // Children-position domain label map: the status pill renders
    // t(TRIP_STATUS_LABELS[trip.status]) — the exact shape the compiler and
    // the ESLint guard cannot see when it regresses to raw values. Scoped to
    // the seeded trip's card so the assertion can only ever be satisfied by
    // THIS pill, not by identical copy elsewhere on the page.
    const tripCard = page.getByRole("link", { name: /Alpine Sweep/ });
    await expect(tripCard).toBeVisible({ timeout: 15_000 });
    await expect(
      tripCard.getByText(pseudo("Draft"), { exact: true }),
    ).toBeVisible();

    // Backend data must stay RAW — pseudo wrapping applies to catalog copy
    // only. A wrapped trip title would mean data is being routed through
    // the catalog (or the wrapper over-reaches).
    await expect(
      page.getByRole("heading", { name: trip.title, exact: true }),
    ).toBeVisible();
  });

  test("planner waypoint spine role labels (the historical raw-map class) are pseudo-wrapped", async ({
    page,
    mockApi,
    user,
  }) => {
    // Seeded routed geometry keeps the planner's dirty-gate from firing
    // live routing; the spine hydrates from GET /trips/:id.
    const trip = await mockApi.seedTrip(user, { title: "Pseudo Spine" });

    await loginStructurally(page, user, `/trips/planner?tripId=${trip.id}`);

    // WAYPOINT_ROLE_LABEL is the planner twin of TripDetailSidebar's
    // WAYPOINT_ROLE — the map family that shipped unregistered once
    // ("Rest"/"Stay", found only by the #1044 whole-branch review). Its
    // values render as JSX children in the draggable spine rows; if the map
    // ever regresses to raw strings that bypass t(), these sentinels vanish.
    //
    // Scoping matters: the assertions are pinned INSIDE the draggable rows
    // because the planner also renders the distinct "START" catalog key
    // (day-plan boundary) and empty-endpoint "start"/"finish" labels —
    // page-wide text matches could be satisfied by those and let a raw role
    // map slip through.
    const spineRows = page.locator('div[draggable="true"]');
    await expect(spineRows.first()).toBeVisible({ timeout: 60_000 });
    await expect(
      spineRows.getByText(pseudo("start"), { exact: true }),
    ).toBeVisible();
    await expect(
      spineRows.getByText(pseudo("finish"), { exact: true }),
    ).toBeVisible();
  });
});
