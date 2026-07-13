import { render, screen } from "@testing-library/react";
import { TripDetailSidebar } from "./TripDetailSidebar";
import type { TripDetail } from "@/lib/types";

function trip(): TripDetail {
  return {
    id: "t1",
    name: "Dolomites weekend",
    status: "planned",
    num_days: 2,
    region: "South Tyrol",
    distance_km: 320,
    days: [
      {
        dayNumber: 1,
        waypoints: [
          {
            id: "w1",
            name: "Bolzano",
            location: { lng: 11.3, lat: 46.5 },
            type: "start",
          },
          {
            id: "w2",
            name: "Passo Sella",
            location: { lng: 11.7, lat: 46.5 },
            type: "via",
          },
        ],
        distanceKm: 180,
        durationMinutes: 240,
        elevationGain: 3200,
        avgQuality: 4.1,
      },
    ],
    parameters: {},
    collaborators: [],
    updatedAt: "2026-07-01T00:00:00Z",
    createdAt: "2026-06-01T00:00:00Z",
  } as unknown as TripDetail;
}

describe("TripDetailSidebar", () => {
  it("renders nothing when idle", () => {
    const { container } = render(
      <TripDetailSidebar state={{ status: "idle" }} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the trip summary + stops when ready", () => {
    render(
      <TripDetailSidebar
        state={{ status: "ready", trip: trip() }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Dolomites weekend")).toBeInTheDocument();
    expect(screen.getByText("South Tyrol")).toBeInTheDocument();
    // The metric tiles (distance formatting is unit-dependent + tested in
    // formatDistance; here just assert the tiles + stops render).
    expect(screen.getByText("Distance")).toBeInTheDocument();
    expect(screen.getByText("Ride time")).toBeInTheDocument();
    // Stops list from the day's waypoints.
    expect(screen.getByText("Bolzano")).toBeInTheDocument();
    expect(screen.getByText("Passo Sella")).toBeInTheDocument();
    // Deep-link to the planner.
    expect(
      screen.getByRole("link", { name: /open in planner/i }),
    ).toHaveAttribute("href", "/trips/t1");
  });

  it("shows an error message", () => {
    render(
      <TripDetailSidebar
        state={{ status: "error", tripId: "t1", message: "Boom" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });
});
