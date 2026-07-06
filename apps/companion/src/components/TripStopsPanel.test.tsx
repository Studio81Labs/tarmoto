import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TripStopsPanel } from "./TripStopsPanel";
import { plannerApi } from "@/lib/planner/api";
import { useTripStore } from "@/stores/trip";
import type { Trip } from "@/lib/types";

// Roughly the Jihlava -> Devet skal road - passes the Vysocina fixtures
// (Devet skal vista, MOL Zdar, Kavarna Nove Mesto, Svratka esses).
function trip(): Trip {
  return {
    id: "trip-1",
    name: "Vysocina run",
    status: "draft",
    num_days: 1,
    createdAt: "2026-04-01T09:00:00Z",
    updatedAt: "2026-04-14T09:00:00Z",
    parameters: {
      days: 1,
      dailyKmTarget: 240,
      roadPreference: "curvy",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    collaborators: [],
    days: [
      {
        dayNumber: 1,
        title: "Day 1",
        distanceKm: 60,
        durationMinutes: 75,
        elevationGain: 400,
        avgQuality: 4.1,
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [15.5912, 49.3961],
            [15.8, 49.48],
            [15.9392, 49.5643],
            [16.05, 49.62],
          ],
        },
        waypoints: [
          {
            id: "start",
            name: "Jihlava",
            location: { lat: 49.3961, lng: 15.5912 },
            type: "start",
          },
          {
            id: "end",
            name: "Devet skal",
            location: { lat: 49.62, lng: 16.05 },
            type: "end",
          },
        ],
        segments: [],
      },
    ],
  };
}

describe("TripStopsPanel (revision 5 - route-wide corridor)", () => {
  beforeEach(() => {
    useTripStore.setState({
      activePoiCategories: new Set(["fuel", "viewpoint", "cafe"]),
    });
  });

  it("is route-gated: without a route it explains instead of an empty list", () => {
    render(<TripStopsPanel trip={null} />);
    expect(
      screen.getByText(/Plan a route to see stops along it/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/STOPS/)).toBeNull();
  });

  it("lists route-wide stops sorted by km-along-route with real distances", async () => {
    render(<TripStopsPanel trip={trip()} />);

    // Corridor query is debounced; the Vysocina fixtures land.
    expect(
      await screen.findByText("MOL Žďár nad Sázavou", undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Devět skal vista")).toBeInTheDocument();

    // No day grouping headers anywhere (revision 5 B).
    expect(screen.queryByText(/^Day 1/)).toBeNull();
    expect(screen.queryByText(/Overnight stays/)).toBeNull();

    // Sorted by km-along-route: the fuel stop precedes the vista near
    // the finish.
    const rows = screen
      .getAllByTitle("Zoom to & add as via")
      .map((row) => row.textContent ?? "");
    const fuelIdx = rows.findIndex((text) =>
      text.includes("MOL Žďár nad Sázavou"),
    );
    const vistaIdx = rows.findIndex((text) =>
      text.includes("Devět skal vista"),
    );
    expect(fuelIdx).toBeGreaterThanOrEqual(0);
    expect(vistaIdx).toBeGreaterThan(fuelIdx);
  });

  it("does not measure the corridor across an unlinked day boundary", async () => {
    // Day 2 starts somewhere else (startLinked: false): the hop between
    // day 1's finish and day 2's start is not ridden, so the corridor
    // must be queried per chain — never along a synthetic connector.
    const spy = vi.spyOn(plannerApi, "getRouteStops");
    const base = trip();
    const day2Coordinates = [
      [16.6, 49.19],
      [16.7, 49.25],
    ];
    render(
      <TripStopsPanel
        trip={{
          ...base,
          days: [
            base.days[0]!,
            {
              ...base.days[0]!,
              dayNumber: 2,
              startLinked: false,
              routeGeometry: {
                type: "LineString",
                coordinates: day2Coordinates,
              },
            },
          ],
        }}
      />,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    const lines = spy.mock.calls.map((call) => call[0]);
    expect(lines[0]!.coordinates).toEqual(
      base.days[0]!.routeGeometry!.coordinates,
    );
    expect(lines[1]!.coordinates).toEqual(day2Coordinates);
    spy.mockRestore();
  });

  it("keeps LINKED days as one continuous corridor line", async () => {
    const spy = vi.spyOn(plannerApi, "getRouteStops");
    const base = trip();
    render(
      <TripStopsPanel
        trip={{
          ...base,
          days: [
            base.days[0]!,
            { ...base.days[0]!, dayNumber: 2, startLinked: true },
          ],
        }}
      />,
    );

    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 2000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].coordinates).toHaveLength(
      base.days[0]!.routeGeometry!.coordinates.length * 2,
    );
    spy.mockRestore();
  });

  it("widening the corridor pulls in farther stops", async () => {
    useTripStore.setState({
      activePoiCategories: new Set(["twisty_highlight"]),
    });
    render(<TripStopsPanel trip={trip()} />);

    // Svratka esses sit well off this line: outside 5 km...
    expect(
      await screen.findByText(
        /No twisty highlights stops within 5 km/,
        undefined,
        {
          timeout: 2000,
        },
      ),
    ).toBeInTheDocument();

    // ...inside a wider corridor.
    fireEvent.click(screen.getByRole("button", { name: "20 km" }));
    expect(
      await screen.findByText("Svratka esses", undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
  });

  it("chips drive the SHARED activePoiCategories set", async () => {
    render(<TripStopsPanel trip={trip()} />);

    fireEvent.click(screen.getByRole("button", { name: /Mountain passes/ }));
    expect(
      useTripStore.getState().activePoiCategories.has("mountain_pass"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Fuel/ }));
    expect(useTripStore.getState().activePoiCategories.has("fuel")).toBe(false);
    await waitFor(
      () => expect(screen.queryByText("MOL Žďár nad Sázavou")).toBeNull(),
      { timeout: 2000 },
    );
  });

  it("row click hands the stop to the map-pin interaction", async () => {
    const onFocusStop = vi.fn();
    render(<TripStopsPanel trip={trip()} onFocusStop={onFocusStop} />);

    fireEvent.click(
      await screen.findByText("Devět skal vista", undefined, {
        timeout: 2000,
      }),
    );
    expect(onFocusStop).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "view-vysocina-1",
        category: "viewpoint",
        kmAlongRoute: expect.any(Number),
        distanceFromRouteKm: expect.any(Number),
      }),
    );
  });

  it("applies the minimum stay rating only to accommodation categories", async () => {
    useTripStore.setState({
      activePoiCategories: new Set(["biker_hotel", "fuel"]),
    });
    render(<TripStopsPanel trip={trip()} />);
    fireEvent.click(screen.getByRole("button", { name: "20 km" }));

    await screen.findByText("MOL Žďár nad Sázavou", undefined, {
      timeout: 2000,
    });

    fireEvent.change(screen.getByLabelText(/Minimum stay rating/), {
      target: { value: "5" },
    });
    // Fuel is untouched by the rating; no hotel fixture reaches 5 stars.
    expect(
      await screen.findByText("MOL Žďár nad Sázavou", undefined, {
        timeout: 2000,
      }),
    ).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByText(/Hotel|Penzion|Chata/)).toBeNull(),
      { timeout: 2000 },
    );
  });
});
