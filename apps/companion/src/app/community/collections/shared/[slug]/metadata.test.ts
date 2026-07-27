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

import { generateMetadata } from "./page";

describe("shared collection metadata localization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
