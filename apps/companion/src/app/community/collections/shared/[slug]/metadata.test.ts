import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchSharedCollection: vi.fn(),
  readFormatPrefs: vi.fn(),
  readLocale: vi.fn(),
  translate: vi.fn(),
}));

vi.mock("@/lib/route-collection-share", () => ({
  fetchSharedCollection: mocks.fetchSharedCollection,
  fetchSharedCollectionPreview: vi.fn(),
}));
vi.mock("@/i18n/server", () => ({
  readLocale: mocks.readLocale,
  t: mocks.translate,
}));
vi.mock("@/format/server", () => ({
  getServerFormatters: vi.fn(),
  readFormatPrefs: mocks.readFormatPrefs,
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

// KEYED — `generateMetadata` reads only `community_access` today, but the page
// body beside it reads `road_quality_overlay` too, and a shared boolean would
// let a gate on the wrong key pass (#1204).
const killSwitches = vi.hoisted(
  () =>
    ({ community_access: true, road_quality_overlay: true }) as Record<
      string,
      boolean
    >,
);
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: async (k: string) => killSwitches[k] ?? true,
}));

import { generateMetadata } from "./page";

describe("shared collection metadata localization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    mocks.readLocale.mockResolvedValue("en");
    mocks.readFormatPrefs.mockResolvedValue({
      formatLocale: "ar-EG",
      timeZone: "Africa/Cairo",
      units: "metric",
    });
    mocks.fetchSharedCollection.mockResolvedValue({
      title: "Alpine roads",
      description: null,
      item_count: 2,
      owner_name: "Ada",
      visibility: "public",
    });
    mocks.translate.mockImplementation(
      (key: string, values?: Record<string, string | number>) =>
        key.replace("{title}", String(values?.title ?? "")),
    );
  });

  it("initializes request format preferences before rendering ICU counts", async () => {
    await generateMetadata({ params: Promise.resolve({ slug: "alps" }) });

    expect(mocks.readFormatPrefs).toHaveBeenCalledOnce();
    expect(mocks.translate).toHaveBeenCalledWith(
      "{count, plural, one {# curated route} other {# curated routes}} shared by {owner}",
      { count: 2, owner: "Ada" },
      "en",
    );
    expect(mocks.readFormatPrefs.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.translate.mock.invocationCallOrder[0]!,
    );
  });
});

describe("shared collection metadata — community_access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    mocks.readLocale.mockResolvedValue("en");
    mocks.readFormatPrefs.mockResolvedValue({
      formatLocale: "en-GB",
      timeZone: "Europe/Prague",
      units: "metric",
    });
    mocks.fetchSharedCollection.mockResolvedValue({
      title: "Alpine roads",
      description: "Best of the Alps",
      item_count: 2,
      owner_name: "Ada",
      visibility: "unlisted",
    });
    mocks.translate.mockImplementation(
      (key: string, values?: Record<string, string | number>) =>
        key.replace("{title}", String(values?.title ?? "")),
    );
  });

  it("builds the title from the collection while the flag is live", async () => {
    // `generateMetadata` is a SECOND entry point — Next runs it independently
    // of the page component, so it needs its own gate and its own test. This
    // is the positive precondition for the two below.
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "alps" }),
    });
    expect(mocks.fetchSharedCollection).toHaveBeenCalledWith("alps");
    expect(meta.title).toBe("Alpine roads — Tarmoto collection");
  });

  it("NEVER FETCHES, and puts no collection text in <head>, under the kill", async () => {
    killSwitches.community_access = false;
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "alps" }),
    });

    expect(mocks.fetchSharedCollection).not.toHaveBeenCalled();
    expect(meta.title).toBe("Collection — Tarmoto");
    expect(JSON.stringify(meta)).not.toContain("Alpine roads");
    expect(JSON.stringify(meta)).not.toContain("Best of the Alps");
  });

  it("KEEPS robots noindex on the killed branch", async () => {
    // The trap: `robots` is normally derived from the `visibility` this branch
    // can no longer fetch, so returning only neutral title text (or `{}`)
    // silently inherits Next's indexable defaults — and would push an unlisted
    // share URL into search results BECAUSE of the shutdown. A kill switch must
    // never leave anything MORE exposed than it found it.
    killSwitches.community_access = false;
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "alps" }),
    });
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("still indexes a public collection when only the quality flag is killed", async () => {
    // Cross-check on the key: `road_quality_overlay` has nothing to do with
    // whether the page is served, so metadata must be untouched by it.
    killSwitches.road_quality_overlay = false;
    mocks.fetchSharedCollection.mockResolvedValue({
      title: "Alpine roads",
      description: "Best of the Alps",
      item_count: 2,
      owner_name: "Ada",
      visibility: "public",
    });
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "alps" }),
    });
    expect(meta.title).toBe("Alpine roads — Tarmoto collection");
    expect(meta.robots).toEqual({ index: true, follow: true });
  });
});
