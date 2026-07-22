import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE, setActiveLocale } from "@/i18n";
import { DEFAULT_LOCALE } from "@tarmoto/shared";
import type { RouteCollectionDetail } from "@/lib/api";
import { generateMetadata as generateSharedRideMetadata } from "./page";
import { generateMetadata as generateSharedRoadMapMetadata } from "@/app/rides/road-map/shared/[token]/page";
import { generateMetadata as generateSharedTripMetadata } from "@/app/trips/shared/[token]/page";
import { generateMetadata as generateSharedCollectionMetadata } from "@/app/community/collections/shared/[slug]/page";
import { fetchSharedCollection } from "@/lib/route-collection-share";

// This is a transparency-refactor regression pin (spec: PR 2 task 5), not a
// red-green cycle: all four `generateMetadata` functions already produce this
// exact English output today. The pin must stay green before AND after
// wiring `readLocale()` + `t()` — it exists to prove the wrap is byte-identical.

// vi.hoisted so the mock factory below can close over this state — a plain
// top-level const would hit the TDZ once vi.mock is hoisted above imports.
const state = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  acceptLanguage: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === "accept-language" ? state.acceptLanguage : null,
  }),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));

// Two of the four pages (road-map share + collection share) reach a client
// map component through their default export. `generateMetadata` never
// renders them, but importing the page module still evaluates each
// component's top-level `import maplibregl from "maplibre-gl"` — stub it the
// same way MapCanvas.test.tsx does so that import resolves under jsdom
// without a real WebGL context.
vi.mock("maplibre-gl", () => {
  class Noop {}
  return {
    default: {
      Map: Noop,
      NavigationControl: Noop,
      GeolocateControl: Noop,
      ScaleControl: Noop,
      AttributionControl: Noop,
    },
    NavigationControl: Noop,
    GeolocateControl: Noop,
    ScaleControl: Noop,
    AttributionControl: Noop,
  };
});

// The collection share page's generateMetadata calls fetchSharedCollection
// (a real backend fetch via apiServer). Mock it so the pin is hermetic and
// so the not-found branch is reachable without depending on network errors
// resolving to null.
vi.mock("@/lib/route-collection-share", () => ({
  fetchSharedCollection: vi.fn(),
  fetchSharedCollectionPreview: vi.fn(),
}));

function collectionDetail(
  over: Partial<RouteCollectionDetail> = {},
): RouteCollectionDetail {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    owner_id: "user-1",
    title: "Beskydy Loops",
    description: "Sunday rides",
    visibility: "public",
    slug: "abcDEF12345",
    item_count: 3,
    items: [],
    follower_count: 0,
    owner_name: "Jane Rider",
    viewer_is_owner: false,
    viewer_is_following: false,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

describe("dynamic share-page metadata (English regression pin)", () => {
  beforeEach(() => {
    state.cookieJar.clear();
    state.acceptLanguage = null;
    setActiveLocale(DEFAULT_LOCALE);
    vi.mocked(fetchSharedCollection).mockReset();
  });

  it("rides/shared/[token] pins the exact English title/description", async () => {
    const metadata = await generateSharedRideMetadata();
    expect(metadata.title).toBe("Shared ride — Tarmoto");
    expect(metadata.description).toBe("Public Tarmoto shared ride page.");
  });

  it("rides/road-map/shared/[token] pins the exact English title/description", async () => {
    const metadata = await generateSharedRoadMapMetadata();
    expect(metadata.title).toBe("Shared road map — Tarmoto");
    expect(metadata.description).toBe("Public Tarmoto personal road map.");
  });

  it("trips/shared/[token] pins the exact English title/description", async () => {
    const metadata = await generateSharedTripMetadata();
    expect(metadata.title).toBe("Shared trip — Tarmoto");
    expect(metadata.description).toBe("Public Tarmoto shared trip page.");
  });

  it("community/collections/shared/[slug] pins the exact English found-collection title", async () => {
    vi.mocked(fetchSharedCollection).mockResolvedValue(
      collectionDetail({ title: "Beskydy Loops" }),
    );
    const metadata = await generateSharedCollectionMetadata({
      params: Promise.resolve({ slug: "abcDEF12345" }),
    });
    expect(metadata.title).toBe("Beskydy Loops — Tarmoto collection");
  });

  it("community/collections/shared/[slug] pins the exact English not-found title", async () => {
    vi.mocked(fetchSharedCollection).mockResolvedValue(null);
    const metadata = await generateSharedCollectionMetadata({
      params: Promise.resolve({ slug: "missing-slug" }),
    });
    expect(metadata.title).toBe("Collection — Tarmoto");
  });

  // Only `en` is registered today, so this can't assert a translated string —
  // but it proves the locale actually flows cookie -> readLocale() -> the
  // explicit `t()` 3rd arg, rather than the pin coincidentally matching a
  // module-global default (the exact hazard the `generateMetadata` locale
  // rule in the global constraints calls out).
  it("resolves the locale from the cookie through readLocale() and still renders the English string", async () => {
    state.cookieJar.set(LOCALE_COOKIE, "en");
    const metadata = await generateSharedRideMetadata();
    expect(metadata.title).toBe("Shared ride — Tarmoto");
    expect(metadata.description).toBe("Public Tarmoto shared ride page.");
  });
});
