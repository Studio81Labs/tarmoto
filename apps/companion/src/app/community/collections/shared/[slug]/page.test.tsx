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

// KEYED. This route reads TWO switches with opposite blast radii —
// `community_access` takes the whole page down, `road_quality_overlay` only
// strips scores — so one boolean for both would let a gate on the wrong key
// pass every assertion here (the finding on #1204). `serverKillSwitchMock` is
// a call RECORDER only, so `mockReset()` in `beforeEach` cannot strip the
// keyed behaviour out from under a test.
const killSwitches = vi.hoisted(
  () =>
    ({ community_access: true, road_quality_overlay: true }) as Record<
      string,
      boolean
    >,
);
const serverKillSwitchMock = vi.fn();
vi.mock("@/lib/serverFlags", () => ({
  serverKillSwitch: async (k: string) => {
    serverKillSwitchMock(k);
    return killSwitches[k] ?? true;
  },
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
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    mapProps.current = null;
    fetchSharedCollectionMock.mockResolvedValue(DETAIL);
    fetchSharedCollectionPreviewMock.mockResolvedValue({ routes: [ITEM] });
  });

  it("passes the recorded quality through when the flag is live", async () => {
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(routesHandedDown()[0]).toHaveProperty("quality_avg", 4.7);
  });

  it("REMOVES the key when the operator kills the overlay", async () => {
    killSwitches.road_quality_overlay = false;
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
    killSwitches.road_quality_overlay = false;
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
    killSwitches.road_quality_overlay = false;
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(routesHandedDown()).toHaveLength(1);
    const serialized = JSON.stringify(mapProps.current);
    expect(serialized).not.toContain("quality_avg");
    expect(serialized).not.toContain("4.7");
  });

  it("gates on road_quality_overlay specifically", async () => {
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(serverKillSwitchMock).toHaveBeenCalledWith("road_quality_overlay");
  });

  it("reads the quality flag alongside the collection, not after it", async () => {
    // `road_quality_overlay` only strips fields, so it must not cost a serial
    // round trip the way `community_access` (which gates the fetch) does.
    let qualityStarted = false;
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
    serverKillSwitchMock.mockImplementation((key: string) => {
      if (key !== "road_quality_overlay") return;
      qualityStarted = true;
      expect(detailResolved).toBe(false);
    });
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(qualityStarted).toBe(true);
  });
});

describe("SharedCollectionPage — community_access", () => {
  beforeEach(() => {
    fetchSharedCollectionMock.mockReset();
    fetchSharedCollectionPreviewMock.mockReset();
    serverKillSwitchMock.mockReset();
    killSwitches.community_access = true;
    killSwitches.road_quality_overlay = true;
    mapProps.current = null;
    fetchSharedCollectionMock.mockResolvedValue(DETAIL);
    fetchSharedCollectionPreviewMock.mockResolvedValue({ routes: [ITEM] });
  });

  it("renders the collection while the flag is live", async () => {
    const { getByText } = render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    // The positive precondition for every absence assertion below.
    expect(getByText("Alps")).toBeInTheDocument();
    expect(fetchSharedCollectionMock).toHaveBeenCalledWith("alps");
  });

  it("NEVER FETCHES the collection under the kill", async () => {
    // The acceptance criterion. Hiding a fetched collection would still read
    // moderated content out of the backend on every crawler hit — the gate has
    // to sit in front of the read, not the render.
    killSwitches.community_access = false;
    render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(fetchSharedCollectionMock).not.toHaveBeenCalled();
    expect(fetchSharedCollectionPreviewMock).not.toHaveBeenCalled();
  });

  it("serves the neutral unavailable body, with no trace of the collection", async () => {
    killSwitches.community_access = false;
    const { getByText, queryByText, container } = render(
      await SharedCollectionPage({ params }),
      { wrapper: withQueryClient() },
    );

    expect(
      getByText("This shared page is temporarily unavailable"),
    ).toBeInTheDocument();
    expect(queryByText("Alps")).not.toBeInTheDocument();
    expect(queryByText("Best of the Alps")).not.toBeInTheDocument();
    // Nothing about the owner or the routes reaches the HTML either — this is
    // the response a crawler gets during a moderation incident.
    expect(container.innerHTML).not.toContain("Rider");
    expect(container.innerHTML).not.toContain("Alpine loop");
  });

  it("says the link still works rather than implying a dead URL", async () => {
    // Why this is not `notFound()`: the recipient should keep the link, and
    // the rider who sent it should not look like they shared a broken one.
    killSwitches.community_access = false;
    const { getByText } = render(await SharedCollectionPage({ params }), {
      wrapper: withQueryClient(),
    });
    expect(getByText(/The link still works/)).toBeInTheDocument();
  });

  it("does not take the page down for a road_quality_overlay kill", async () => {
    // The two switches move independently: killing quality strips scores and
    // leaves the collection readable. Without this, a gate written against the
    // wrong key would satisfy every other test in this file.
    killSwitches.road_quality_overlay = false;
    const { getByText, queryByText } = render(
      await SharedCollectionPage({ params }),
      { wrapper: withQueryClient() },
    );
    expect(getByText("Alps")).toBeInTheDocument();
    expect(
      queryByText("This shared page is temporarily unavailable"),
    ).not.toBeInTheDocument();
  });
});
