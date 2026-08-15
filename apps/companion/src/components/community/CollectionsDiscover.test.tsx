import { render, screen, waitFor } from "@testing-library/react";
import { t } from "@/i18n";

// KEYED: a gate written against the wrong key would otherwise satisfy every
// assertion below (#1204). This surface reads one system switch today, but the
// collections page around it reads `community_access` too.
const systemSwitches = vi.hoisted(
  () => ({ sys_community_collections: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEntitlements")>()),
  useSystemSwitch: (key: string) => ({
    enabled: systemSwitches[key] ?? true,
    isResolved: true,
  }),
}));

const fetchDiscoverMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/collections-discover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/collections-discover")>()),
  fetchDiscoverCollections: (...a: unknown[]) => fetchDiscoverMock(...a),
  fetchCollectionMosaic: vi.fn(async () => []),
}));

import { CollectionMetric, CollectionsDiscover } from "./CollectionsDiscover";
import { useAuthStore } from "@/stores/auth";

function card(over: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    slug: "alpine-passes",
    title: "Alpine Passes",
    description: null,
    owner_id: "u-9",
    owner_name: "Rider",
    item_count: 4,
    follower_count: 12,
    viewer_is_following: false,
    updated_at: "2026-05-01T08:00:00.000Z",
    ...over,
  };
}

describe("CollectionMetric", () => {
  it.each([
    { count: 1, formattedCount: "1", kind: "routes", label: "1 ROUTE" },
    {
      count: 2,
      formattedCount: "2",
      kind: "routes",
      label: "2 ROUTES",
    },
    {
      count: 1,
      formattedCount: "1",
      kind: "followers",
      label: "1 FOLLOW",
    },
    {
      count: 2,
      formattedCount: "2",
      kind: "followers",
      label: "2 FOLLOWS",
    },
  ] as const)(
    "renders the cataloged $kind label for count $count with an emphasized count",
    ({ count, formattedCount, kind, label }) => {
      const { container } = render(
        <CollectionMetric
          count={count}
          formattedCount={formattedCount}
          kind={kind}
          t={t}
        />,
      );

      expect(container.textContent).toBe(label);
      expect(screen.getByText(formattedCount)).toHaveClass(
        "font-bold",
        "text-ink",
      );
    },
  );
});

describe("CollectionsDiscover — sys_community_collections", () => {
  beforeEach(() => {
    systemSwitches.sys_community_collections = true;
    fetchDiscoverMock.mockReset();
    fetchDiscoverMock.mockResolvedValue({ items: [card()], total: 1 });
    useAuthStore.setState({
      accessToken: "tok",
      isAuthenticated: true,
      user: { id: "u-1", email: "r@example.com", displayName: "Rider" },
    });
  });

  it("renders the feed while the switch is live", async () => {
    render(<CollectionsDiscover search="" />);
    expect(await screen.findByText("Alpine Passes")).toBeInTheDocument();
  });

  it("SAYS UNAVAILABLE instead of vanishing when the switch is off", async () => {
    // `listDiscover` answers an empty page under the switch, and this section
    // renders nothing for an empty list — so the feed would just disappear,
    // indistinguishable from a community with no public collections.
    systemSwitches.sys_community_collections = false;
    render(<CollectionsDiscover search="" />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    // The heading stays, so the section reads as paused rather than missing.
    expect(screen.getByText("Discover")).toBeInTheDocument();
    // Past the 200 ms debounce. Asserting straight after the notice appears
    // proves nothing: the request would not have been issued yet either way.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchDiscoverMock).not.toHaveBeenCalled();
  });

  it("drops a LOADED feed on a live flip", async () => {
    // A rider already browsing when an operator flips must lose the feed too —
    // the collections it lists are exactly what the switch stops serving.
    const { rerender } = render(<CollectionsDiscover search="" />);
    expect(await screen.findByText("Alpine Passes")).toBeInTheDocument();

    systemSwitches.sys_community_collections = false;
    rerender(<CollectionsDiscover search="" />);

    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Alpine Passes")).not.toBeInTheDocument();
  });

  it("REFETCHES a fresh feed when the switch is restored", async () => {
    // The paused branch clears `items`, so restoring has to re-request or the
    // section comes back permanently empty (which renders as nothing at all).
    systemSwitches.sys_community_collections = false;
    const { rerender } = render(<CollectionsDiscover search="" />);
    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();

    systemSwitches.sys_community_collections = true;
    rerender(<CollectionsDiscover search="" />);

    await waitFor(() => expect(fetchDiscoverMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Alpine Passes")).toBeInTheDocument();
  });

  it("does not resurrect the pre-shutdown feed when a restore fails", async () => {
    // The paused branch clears `items` for this: collections can be unpublished
    // while the subsystem is down, and the refetch swallows its rejection — so
    // a retained list would come straight back on the flip and stay, with
    // nothing left to replace it.
    const { rerender } = render(<CollectionsDiscover search="" />);
    expect(await screen.findByText("Alpine Passes")).toBeInTheDocument();

    systemSwitches.sys_community_collections = false;
    rerender(<CollectionsDiscover search="" />);
    expect(
      await screen.findByText(/temporarily unavailable/i),
    ).toBeInTheDocument();

    fetchDiscoverMock.mockRejectedValue(new Error("boom"));
    systemSwitches.sys_community_collections = true;
    rerender(<CollectionsDiscover search="" />);

    await waitFor(() => expect(fetchDiscoverMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Alpine Passes")).not.toBeInTheDocument();
  });

  it("is not gated by an unrelated system switch", async () => {
    // Different keys, different blast radii: only this one takes the feed down.
    systemSwitches.sys_gamification = false;
    render(<CollectionsDiscover search="" />);
    expect(await screen.findByText("Alpine Passes")).toBeInTheDocument();
  });
});
