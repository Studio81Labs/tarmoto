import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// KEYED even though this page reads one switch today — a key-blind mock is
// what let a gate on the wrong flag pass on #1204, and this page is one
// `useFeature` away from being multi-switch (#1167 gates it on
// `advanced_analytics`).
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
// KEYED for the same reason: `advanced_analytics` (Premium, gates this whole
// page) and `advanced_ride_stats` (Pro) are one word apart, and a key-blind
// mock would let a gate on the wrong one pass every assertion here.
const features = vi.hoisted(
  () => ({ advanced_analytics: true }) as Record<string, boolean>,
);
const entitlements = vi.hoisted(() => ({
  tier: "premium" as string | null,
  isLoading: false,
  isSuccess: true,
}));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
  useFeature: (key: string) => ({
    enabled: features[key] ?? false,
    isLoading: entitlements.isLoading,
    isError: false,
    isSuccess: entitlements.isSuccess,
    dataUpdatedAt: 0,
  }),
  useEntitlements: () => ({
    tier: entitlements.tier,
    features: null,
    limits: null,
    isLoading: entitlements.isLoading,
    isError: false,
    isSuccess: entitlements.isSuccess,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/format/FormatProvider", async () => {
  const { createFormatters } = await import("@tarmoto/shared");
  const format = createFormatters({ locale: "en", units: "metric" });
  return { useFormat: () => format };
});
const translate = (key: string) => key;
vi.mock("@/i18n/I18nProvider", () => ({
  useTranslation: () => translate,
  useI18n: () => ({ locale: "en", t: translate }),
}));

// The locked teaser's upgrade CTA pushes to /settings/subscription, and the
// prompt behind it resolves the billing switch + upgrade routing. Both have
// their own suites (`UpgradePrompt`, `hooks/useUpgradeRouting`); here they only
// need to not drag NextAuth and react-query into a page test.
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));
vi.mock("@/hooks", () => ({
  useSystemSwitch: () => ({ enabled: true, isResolved: true }),
  useUpgradeRouting: () => ({ needsCheckout: true, isResolved: true }),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { accessToken: string | null }) => unknown) =>
    sel({ accessToken: "token" }),
}));

const fetchAllRidesMock = vi.fn();
vi.mock("@/lib/rides-fetch", () => ({
  fetchAllRides: (...a: unknown[]) => fetchAllRidesMock(...a),
}));

// The breakdown is a SEPARATE effect hitting a separate endpoint — the one the
// backend gates — so it needs its own spy or "no fetch while locked" would be
// half an assertion.
const fetchRideBreakdownMock = vi.fn();
vi.mock("@/lib/rides-breakdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rides-breakdown")>()),
  fetchRideBreakdown: (...a: unknown[]) => fetchRideBreakdownMock(...a),
}));

import RideStatsPage from "./page";

function ride(overrides: Record<string, unknown> = {}) {
  return {
    id: "ride-1",
    name: "Alpine loop",
    status: "completed",
    ride_type: "trip",
    started_at: "2026-05-01T08:00:00.000Z",
    ended_at: "2026-05-01T10:00:00.000Z",
    distance_km: 120,
    duration_min: 120,
    avg_speed: 60,
    avg_road_quality: 4.2,
    curve_count: 140,
    surface_type: "asphalt",
    ...overrides,
  };
}

describe("RideStatsPage — road_quality_overlay", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
    fetchAllRidesMock.mockReset();
    fetchAllRidesMock.mockResolvedValue([ride(), ride({ id: "ride-2" })]);
    fetchRideBreakdownMock.mockReset();
    fetchRideBreakdownMock.mockResolvedValue({ surfaces: [], curviness: [] });
    features.advanced_analytics = true;
    entitlements.tier = "premium";
    entitlements.isLoading = false;
    entitlements.isSuccess = true;
  });

  it("renders the quality trend card while the flag is live", async () => {
    render(<RideStatsPage />);
    expect(await screen.findByText("Average road quality")).toBeInTheDocument();
    expect(screen.getByText(/road-quality trends/)).toBeInTheDocument();
  });

  it("removes the trend card under the kill and keeps the rest of the page", async () => {
    killSwitches.road_quality_overlay = false;
    render(<RideStatsPage />);

    // Anchor on something that must always render, so the absence assertion
    // below cannot pass merely because the page never loaded.
    await waitFor(() => expect(fetchAllRidesMock).toHaveBeenCalled());
    await screen.findByText("How twisty was your year");

    expect(screen.queryByText("Average road quality")).not.toBeInTheDocument();
    // The header NAMES the card, so it must not advertise content the page no
    // longer has — the same mistake as a map legend outliving its layers.
    expect(screen.queryByText(/road-quality trends/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Yearly distance and ride breakdown/),
    ).toBeInTheDocument();
    // This still matters after #1167 gates the route on `advanced_analytics`:
    // that locks it for non-entitled riders, but an ENTITLED one would keep
    // seeing a trend the operator had killed.
  });

  it("drops the trend card and the header clause on a LIVE flip", async () => {
    const { rerender } = render(<RideStatsPage />);
    expect(await screen.findByText("Average road quality")).toBeInTheDocument();

    killSwitches.road_quality_overlay = false;
    rerender(<RideStatsPage />);

    expect(screen.queryByText("Average road quality")).not.toBeInTheDocument();
    expect(screen.queryByText(/road-quality trends/)).not.toBeInTheDocument();
    expect(screen.getByText("How twisty was your year")).toBeInTheDocument();
  });
});

describe("RideStatsPage — advanced_analytics", () => {
  beforeEach(() => {
    killSwitches.road_quality_overlay = true;
    fetchAllRidesMock.mockReset();
    fetchAllRidesMock.mockResolvedValue([ride(), ride({ id: "ride-2" })]);
    fetchRideBreakdownMock.mockReset();
    fetchRideBreakdownMock.mockResolvedValue({ surfaces: [], curviness: [] });
    features.advanced_analytics = true;
    entitlements.tier = "premium";
    entitlements.isLoading = false;
    entitlements.isSuccess = true;
  });

  it("renders the page for an entitled rider", async () => {
    render(<RideStatsPage />);
    expect(await screen.findByText("Average road quality")).toBeInTheDocument();
  });

  it("LOCKS the page for a rider without the entitlement", async () => {
    features.advanced_analytics = false;
    entitlements.tier = "free";
    render(<RideStatsPage />);

    expect(await screen.findByText("Advanced analytics")).toBeInTheDocument();
    // The header stays, so the route never shows an unexplained gap.
    expect(screen.getByText("Ride analytics")).toBeInTheDocument();
    // NOT the generic empty state — "no rides recorded" would blame the rider
    // for a tier boundary.
    expect(screen.queryByText("No rides recorded yet")).not.toBeInTheDocument();
  });

  it("fails CLOSED while the snapshot is unresolved", async () => {
    // `isSuccess: false` with no error and no loading is the auth-hydration
    // window: not "entitled", just unknown.
    features.advanced_analytics = true;
    entitlements.isSuccess = false;
    render(<RideStatsPage />);

    expect(await screen.findByText("Advanced analytics")).toBeInTheDocument();
  });

  it("issues NEITHER request while locked", async () => {
    // Two separate effects, two separate endpoints. Gating only the ride
    // paging would leave the breakdown call hitting the endpoint the backend
    // gates — a 403 on every visit by a Free rider.
    features.advanced_analytics = false;
    entitlements.tier = "free";
    render(<RideStatsPage />);

    await screen.findByText("Advanced analytics");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchAllRidesMock).not.toHaveBeenCalled();
    expect(fetchRideBreakdownMock).not.toHaveBeenCalled();
  });

  it("issues neither request while UNRESOLVED", async () => {
    entitlements.isSuccess = false;
    render(<RideStatsPage />);

    await screen.findByText("Advanced analytics");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchAllRidesMock).not.toHaveBeenCalled();
    expect(fetchRideBreakdownMock).not.toHaveBeenCalled();
  });

  it("UNLOCKS on a live upgrade, without a reload", async () => {
    features.advanced_analytics = false;
    entitlements.tier = "free";
    const { rerender } = render(<RideStatsPage />);
    expect(await screen.findByText("Advanced analytics")).toBeInTheDocument();

    features.advanced_analytics = true;
    entitlements.tier = "premium";
    rerender(<RideStatsPage />);

    expect(await screen.findByText("Average road quality")).toBeInTheDocument();
    expect(fetchAllRidesMock).toHaveBeenCalled();
    expect(fetchRideBreakdownMock).toHaveBeenCalled();
  });

  it("sells PREMIUM to a Pro rider, not the flag they already hold", async () => {
    // `advanced_ride_stats` is Pro-and-up, so the card's default capability
    // resolves no upgrade target for a Pro rider — leaving the tier most
    // likely to buy with no CTA on a Premium-only page.
    features.advanced_analytics = false;
    entitlements.tier = "pro";
    render(<RideStatsPage />);

    expect(await screen.findByText("Advanced analytics")).toBeInTheDocument();
    expect(screen.queryByText(/Limit reached/i)).not.toBeInTheDocument();
  });
});
