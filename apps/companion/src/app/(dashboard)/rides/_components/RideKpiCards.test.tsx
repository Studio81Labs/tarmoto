import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RideStats } from "@tarmoto/shared";
import { RideKpiCards } from "./RideKpiCards";

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
  it("rounds normal totals to whole KM / HRS", () => {
    render(<RideKpiCards stats={stats()} />);
    expect(screen.getByText("1,284")).toBeInTheDocument();
    expect(screen.getByText("KM")).toBeInTheDocument();
    expect(screen.getByText("33")).toBeInTheDocument(); // 32.6 → 33
    expect(screen.getByText("HRS")).toBeInTheDocument();
    expect(screen.getByText("4.1")).toBeInTheDocument(); // 4.137 → 4.1
  });

  it("shows sub-km distance in meters instead of flooring to 0 KM", () => {
    render(<RideKpiCards stats={stats({ total_distance_km: 0.4 })} />);
    expect(screen.getByText("400")).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows sub-hour ride time in minutes instead of flooring to 0 HRS", () => {
    render(<RideKpiCards stats={stats({ total_hours: 0.3333 })} />);
    expect(screen.getByText("20")).toBeInTheDocument(); // 0.333 h → 20 min
    expect(screen.getByText("MIN")).toBeInTheDocument();
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
});
