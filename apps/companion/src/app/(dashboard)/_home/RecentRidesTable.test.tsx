import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecentRidesTable } from "./RecentRidesTable";
import type { UserRide } from "@/hooks/useUserRides";

const ride: UserRide = {
  id: "r1",
  name: "Stelvio Loop",
  status: "completed",
  ride_type: "tour",
  started_at: "2026-04-18T08:00:00Z",
  ended_at: "2026-04-18T12:12:00Z",
  distance_km: 186,
  duration_min: 252,
  avg_speed: 64,
  avg_road_quality: 4.6,
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
    // "18 Apr" appears in both the DATE cell and the RIDE label cell — assert 2 occurrences
    const matches = screen.getAllByText("18 Apr");
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
