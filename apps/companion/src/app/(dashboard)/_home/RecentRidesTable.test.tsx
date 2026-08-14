import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecentRidesTable } from "./RecentRidesTable";
import type { UserRide } from "@/hooks/useUserRides";

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

const ride: UserRide = {
  id: "r1",
  name: "Stelvio Loop",
  status: "completed",
  ride_type: "trip",
  started_at: "2026-04-18T08:00:00Z",
  ended_at: "2026-04-18T12:12:00Z",
  distance_km: 186,
  duration_min: 252,
  avg_speed: 64,
  avg_road_quality: 4.6,
  avg_curviness: null,
  bike_id: null,
  max_lean_angle: null,
};

describe("RecentRidesTable", () => {
  it("renders a row with distance, formatted duration, avg speed and quality", () => {
    render(<RecentRidesTable rides={[ride]} />);
    expect(screen.getByText("Stelvio Loop")).toBeInTheDocument();
    expect(screen.getByText("186")).toBeInTheDocument();
    expect(screen.getByText("4h 12m")).toBeInTheDocument();
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByLabelText(/Quality 5 of 5/)).toBeInTheDocument();
  });

  it("renders em-dash for quality and no QualityBars when avg_road_quality is null", () => {
    const noQuality: UserRide = { ...ride, id: "r2", avg_road_quality: null };
    render(<RecentRidesTable rides={[noQuality]} />);
    // No QualityBars aria-label present
    expect(screen.queryByLabelText(/Quality \d of 5/)).not.toBeInTheDocument();
    // Em-dash rendered in quality cell
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the short date as ride label when name is null", () => {
    const noName: UserRide = {
      ...ride,
      id: "r3",
      name: null,
      started_at: "2026-04-18T08:00:00Z",
    };
    render(<RecentRidesTable rides={[noName]} />);
    // "Apr 18" appears in both the DATE cell and the RIDE label cell (default
    // en/UTC seam formatting — month before day) — assert 2 occurrences.
    const matches = screen.getAllByText("Apr 18");
    expect(matches).toHaveLength(2);
  });

  it("renders compact sub-hour duration as '52m'", () => {
    const shortRide: UserRide = { ...ride, id: "r4", duration_min: 52 };
    render(<RecentRidesTable rides={[shortRide]} />);
    expect(screen.getByText("52m")).toBeInTheDocument();
  });

  it("renders the header row without throwing when rides is empty", () => {
    render(<RecentRidesTable rides={[]} />);
    expect(screen.getByText("DATE")).toBeInTheDocument();
    expect(screen.getByText("RIDE")).toBeInTheDocument();
    expect(screen.getByText("QUALITY")).toBeInTheDocument();
  });
});

describe("RecentRidesTable — road_quality_overlay", () => {
  it("drops the QUALITY column under the kill", () => {
    // The dashboard parent already read this switch for its own map and never
    // threaded it down, so this table kept rendering quality through a kill.
    killSwitches.road_quality_overlay = false;
    render(<RecentRidesTable rides={[ride]} />);
    expect(screen.queryByText("QUALITY")).not.toBeInTheDocument();
  });
});
