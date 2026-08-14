import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// KEYED even though this page reads one switch today — a key-blind mock is
// what let a gate on the wrong flag pass on #1204, and this page is one
// `useFeature` away from being multi-switch (#1167 gates it on
// `advanced_analytics`).
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
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

vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { accessToken: string | null }) => unknown) =>
    sel({ accessToken: "token" }),
}));

const fetchAllRidesMock = vi.fn();
vi.mock("@/lib/rides-fetch", () => ({
  fetchAllRides: (...a: unknown[]) => fetchAllRidesMock(...a),
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
});
