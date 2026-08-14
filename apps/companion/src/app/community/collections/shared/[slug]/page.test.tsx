import { render } from "@testing-library/react";
import { withQueryClient } from "@/hooks/test-utils";

vi.mock("@/i18n/server", () => ({
  readLocale: vi.fn(async () => "en"),
  t: (key: string) => key,
}));
vi.mock("@/format/server", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { getServerFormatters: async () => format };
});

const fetchSharedCollectionMock = vi.fn();
const fetchSharedCollectionPreviewMock = vi.fn();
// `stripCollectionQuality` stays REAL — it is the thing under test.
vi.mock("@/lib/route-collection-share", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-collection-share")>()),
  fetchSharedCollection: (...a: unknown[]) => fetchSharedCollectionMock(...a),
  fetchSharedCollectionPreview: (...a: unknown[]) =>
    fetchSharedCollectionPreviewMock(...a),
}));

const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: (k: string) => serverKillSwitchMock(k),
}));

// Capture what crosses into the `"use client"` preview map.
const mapProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/community/CollectionPreviewMap", () => ({
  CollectionPreviewMap: (props: unknown) => {
    mapProps.current = props;
    return <div data-testid="preview-map" />;
  },
}));

import SharedCollectionPage from "./page";

// The FULL `RouteCollectionPreviewItemDto`.
const ITEM = {
  item_id: "item-1",
  position: 0,
  target_id: "ride-1",
  lines: [
    [
      [16.6, 49.2],
      [16.7, 49.3],
    ],
  ],
  title: "Alpine loop",
  distance_km: 120,
  status: "completed",
  quality_avg: 4.7,
};

const DETAIL = {
  slug: "alps",
  title: "Alps",
  description: "Best of the Alps",
  owner_name: "Rider",
  item_count: 1,
  visibility: "public",
};

const params = Promise.resolve({ slug: "alps" });

function routesHandedDown(): Record<string, unknown>[] {
  // Fail loudly rather than vacuously — if the map is never rendered, every
  // "no trace" assertion below would pass against `null` proving nothing.
  if (mapProps.current === null) {
    throw new Error("CollectionPreviewMap was never rendered");
  }
  return (mapProps.current as { routes: Record<string, unknown>[] }).routes;
}

describe("SharedCollectionPage — road_quality_overlay", () => {
  beforeEach(() => {
    fetchSharedCollectionMock.mockReset();
    fetchSharedCollectionPreviewMock.mockReset();
    serverKillSwitchMock.mockReset();
    mapProps.current = null;
    fetchSharedCollectionMock.mockResolvedValue(DETAIL);
    fetchSharedCollectionPreviewMock.mockResolvedValue({ routes: [ITEM] });
  });

  it("passes the recorded quality through when the flag is live", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(routesHandedDown()[0]).toHaveProperty("quality_avg", 4.7);
  });

  it("REMOVES the key when the operator kills the overlay", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });

    const [first] = routesHandedDown();
    expect(first).not.toHaveProperty("quality_avg");
    // The allowlist, pinned: everything else on the DTO has a real consumer,
    // so a field the backend adds later cannot ride along silently.
    expect(Object.keys(first!).sort()).toEqual([
      "distance_km",
      "item_id",
      "lines",
      "position",
      "status",
      "target_id",
      "title",
    ]);
  });

  it("projects an ALLOWLIST, so a new backend field cannot leak by default", async () => {
    // The distinguishing case: with the CURRENT DTO a blocklist and an
    // allowlist agree, so only a field the projection was never told about
    // tells them apart — which is exactly the regression an allowlist exists
    // to prevent when the backend adds a column.
    serverKillSwitchMock.mockResolvedValue(false);
    fetchSharedCollectionPreviewMock.mockResolvedValue({
      routes: [{ ...ITEM, some_future_quality_field: 4.7 }],
    });
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(routesHandedDown()[0]).not.toHaveProperty(
      "some_future_quality_field",
    );
    expect(JSON.stringify(mapProps.current)).not.toContain("4.7");
  });

  it("leaves no trace of the score in the serialized props", async () => {
    serverKillSwitchMock.mockResolvedValue(false);
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(routesHandedDown()).toHaveLength(1);
    const serialized = JSON.stringify(mapProps.current);
    expect(serialized).not.toContain("quality_avg");
    expect(serialized).not.toContain("4.7");
  });

  it("gates on road_quality_overlay specifically", async () => {
    serverKillSwitchMock.mockResolvedValue(true);
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(serverKillSwitchMock).toHaveBeenCalledWith("road_quality_overlay");
  });

  it("reads the flag alongside the collection, not after it", async () => {
    let flagStarted = false;
    let detailResolved = false;
    fetchSharedCollectionMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            detailResolved = true;
            resolve(DETAIL);
          }, 10),
        ),
    );
    serverKillSwitchMock.mockImplementation(async () => {
      flagStarted = true;
      expect(detailResolved).toBe(false);
      return true;
    });
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(flagStarted).toBe(true);
  });
});
