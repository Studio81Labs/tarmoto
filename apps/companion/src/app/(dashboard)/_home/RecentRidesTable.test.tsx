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
});
