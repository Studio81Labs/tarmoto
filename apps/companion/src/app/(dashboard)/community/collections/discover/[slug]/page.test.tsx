import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "alps" }) }));
// Stable identity: this client lands in a `useCallback` dependency list, so a
// fresh object per render re-creates `reload` forever and OOMs the worker.
const queryClientStub = vi.hoisted(() => ({ invalidateQueries: () => {} }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClientStub,
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { accessToken: string | null }) => unknown) =>
    sel({ accessToken: "token" }),
}));
vi.mock("@/format/FormatProvider", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { useFormat: () => format };
});
// Stable identity, same reason as the query client: `reload` is a
// `useCallback` with `[t]`, so a fresh translator per render re-creates it,
// re-fires the fetch effect and loops until the worker OOMs.
const tStub = vi.hoisted(() => (key: string) => key);
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => tStub,
}));

const getBySlugMock = vi.fn();
const getPreviewBySlugMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  routeCollectionsApi: {
    getBySlug: (...a: unknown[]) => getBySlugMock(...a),
    getPreviewBySlug: (...a: unknown[]) => getPreviewBySlugMock(...a),
  },
}));

vi.mock("@/components/community/CollectionPreviewMap", () => ({
  CollectionPreviewMap: () => <div data-testid="preview-map" />,
}));

// Capture what the row is handed — the row itself renders on the SERVER for
// the public shared route, so it must stay hook-free and the strip happens
// here instead.
const rowProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@/components/community/collection-route-atoms", () => ({
  CollectionRouteRow: (props: { route: Record<string, unknown> }) => {
    rowProps.calls.push(props.route);
    return <li data-testid="route-row">{String(props.route.title)}</li>;
  },
}));

import DiscoverCollectionPage from "./page";

const ITEM = {
  item_id: "item-1",
  position: 0,
  target_id: "ride-1",
  lines: [],
  title: "Alpine loop",
  distance_km: 120,
  status: "completed",
  quality_avg: 4.7,
};

const DETAIL = {
  id: "col-1",
  slug: "alps",
  title: "Alps",
  description: null,
  owner_name: "Rider",
  owner_id: "u1",
  item_count: 1,
  visibility: "public",
  viewer_is_following: false,
  viewer_is_owner: false,
  follower_count: 3,
  created_at: "2026-05-01T08:00:00.000Z",
};

describe("DiscoverCollectionPage — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitch.enabled = true;
    rowProps.calls.length = 0;
    getBySlugMock.mockReset();
    getPreviewBySlugMock.mockReset();
    getBySlugMock.mockResolvedValue({ data: DETAIL });
    getPreviewBySlugMock.mockResolvedValue({ data: { routes: [ITEM] } });
  });

  it("passes the recorded quality through while the flag is live", async () => {
    render(<DiscoverCollectionPage />);
    await waitFor(() => expect(screen.getByTestId("route-row")).toBeTruthy());
    expect(rowProps.calls.at(-1)).toHaveProperty("quality_avg", 4.7);
  });

  it("REMOVES quality_avg from the row's data when the overlay is killed", async () => {
    killSwitch.enabled = false;
    render(<DiscoverCollectionPage />);
    await waitFor(() => expect(screen.getByTestId("route-row")).toBeTruthy());

    const route = rowProps.calls.at(-1)!;
    // Stripped rather than gated inside the row: that row also renders on the
    // server for the public shared collection route, so it cannot hold a hook.
    expect(route).not.toHaveProperty("quality_avg");
    // Everything else the row renders survives.
    expect(route).toHaveProperty("title", "Alpine loop");
    expect(route).toHaveProperty("distance_km", 120);
  });
});
