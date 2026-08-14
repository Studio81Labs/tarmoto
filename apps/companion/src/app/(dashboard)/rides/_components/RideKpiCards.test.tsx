import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RideStats } from "@tarmoto/shared";
import { RideKpiCards } from "./RideKpiCards";
import { FormatProvider } from "@/format/FormatProvider";

// `road_quality_overlay` gates the quality column/tile/filter; the real hook
// needs a QueryClientProvider these suites do not render. Keyed so a case that
// kills one switch cannot silently flip another.
const killSwitches = vi.hoisted(
  () => ({ road_quality_overlay: true }) as Record<string, boolean>,
);
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: (key: string) => ({
    enabled: killSwitches[key] ?? true,
    isResolved: true,
  }),
}));

function stats(overrides: Partial<RideStats> = {}): RideStats {
  return {
    total_distance_km: 1284.4,
    total_hours: 32.6,
    new_roads: 47,
    avg_quality: 4.137,
    ride_count: 8,
    ...overrides,
  };
}

describe("RideKpiCards", () => {
  it("formats metric distance/time per the rider's units (default metric)", () => {
    render(<RideKpiCards stats={stats()} />);
    // Distance respects the unit preference via the format seam's
    // splitDistanceKm, which keeps one decimal (1284.4 km → "1,284.4"); ride
    // time rounds to whole hours.
    expect(screen.getByText("1,284.4")).toBeInTheDocument();
    // The unit comes straight from Intl's short unit display (lowercase);
    // MetricTile's own "uppercase" CSS class still renders it capitalized.
    expect(screen.getByText("km")).toBeInTheDocument();
    expect(screen.getByText("33")).toBeInTheDocument(); // 32.6 → 33
    expect(screen.getByText("hr")).toBeInTheDocument();
    expect(screen.getByText("4.1 / 5")).toBeInTheDocument(); // 4.137 → 4.1
  });

  it("keeps a decimal for sub-km distance instead of flooring to 0 km", () => {
    // format.splitDistanceKm has no meters branch (unlike the retired
    // splitFormattedDistance) — sub-km totals now show a fractional km
    // value rather than switching to meters. Intended seam behavior change.
    render(<RideKpiCards stats={stats({ total_distance_km: 0.4 })} />);
    expect(screen.getByText("0.4")).toBeInTheDocument();
    expect(screen.getByText("km")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows sub-hour ride time in minutes instead of flooring to 0 hr", () => {
    render(<RideKpiCards stats={stats({ total_hours: 0.3333 })} />);
    expect(screen.getByText("20")).toBeInTheDocument(); // 0.333 h → 20 min
    expect(screen.getByText("min")).toBeInTheDocument();
  });

  it("renders em dashes (not zeros) when stats are unavailable", () => {
    render(<RideKpiCards stats={null} />);
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("surfaces an inline error when the stats fetch failed", () => {
    render(<RideKpiCards stats={null} error />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't load ride stats/i,
    );
  });

  it("groups large totals via the shared number formatter", () => {
    // Default locale (en) groups thousands; the value is run through the
    // format seam's splitDistanceKm, not String(), so it isn't a bare
    // "12643".
    render(<RideKpiCards stats={stats({ total_distance_km: 12643 })} />);
    expect(screen.getByText("12,643")).toBeInTheDocument();
    expect(screen.queryByText("12643")).not.toBeInTheDocument();
  });

  it("renders units before values for locales whose grammar requires it", () => {
    render(
      <FormatProvider formatLocale="sw" timeZone="UTC" units="metric">
        <RideKpiCards stats={stats()} />
      </FormatProvider>,
    );

    const unit = screen.getByText("saa");
    expect(unit.parentElement?.textContent).toBe("saa33");
  });

  it("renders regional numerals in a complete quality measurement", () => {
    render(
      <FormatProvider formatLocale="ar-EG" timeZone="UTC" units="metric">
        <RideKpiCards stats={stats()} />
      </FormatProvider>,
    );

    expect(screen.getByText("٤٫١ / ٥")).toBeInTheDocument();
  });
});

describe("RideKpiCards — road_quality_overlay", () => {
  it("drops the Avg quality tile under the kill", () => {
    killSwitches.road_quality_overlay = true;
    const { unmount } = render(<RideKpiCards stats={stats()} />);
    expect(screen.getByText("Avg quality")).toBeInTheDocument();
    unmount();

    killSwitches.road_quality_overlay = false;
    render(<RideKpiCards stats={stats()} />);
    expect(screen.queryByText("Avg quality")).not.toBeInTheDocument();
    expect(screen.getByText("Roads")).toBeInTheDocument();
  });
});
