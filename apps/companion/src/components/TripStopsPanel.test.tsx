import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TripStopsPanel } from "./TripStopsPanel";
import { useTripStops } from "@/hooks/useTripStops";
import { useTripStore } from "@/stores/trip";
import type { Trip } from "@/lib/types";
import type { TripDayStops } from "@/lib/trip-stops";

vi.mock("@/hooks/useTripStops", () => ({
  useTripStops: vi.fn(),
}));

function trip(): Trip {
  return {
    id: "trip-1",
    name: "Alps loop",
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
        title: "Stelvio",
        distanceKm: 248,
        durationMinutes: 360,
        elevationGain: 2640,
        avgQuality: 4.1,
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [10.37, 46.47],
            [10.42, 46.5],
            [10.57, 46.61],
          ],
        },
        waypoints: [
          {
            id: "start",
            name: "Bormio",
            location: { lat: 46.47, lng: 10.37 },
            type: "start",
          },
          {
            id: "end",
            name: "Prato allo Stelvio",
            location: { lat: 46.61, lng: 10.57 },
            type: "end",
          },
        ],
      },
    ],
  };
}

const dayStops: TripDayStops[] = [
  {
    dayNumber: 1,
    title: "Stelvio",
    routeAvailable: true,
    endLabel: "Prato allo Stelvio",
    accommodations: [
      {
        external_id: "stay-1",
        name: "Hotel Stelvio",
        kind: "hotel",
        lat: 46.61,
        lng: 10.57,
        distance_km: 0.8,
        website: "https://hotel.example.com",
        phone: "+39000000000",
        stars: 4,
      },
    ],
    pois: [
      {
        external_id: "fuel-1",
        name: "Shell Bormio",
        kind: "fuel_station",
        lat: 46.53,
        lng: 10.45,
        distance_along_route_km: 72,
        distance_from_route_km: 0.2,
        website: null,
        phone: null,
        hint: "Shell",
      },
      {
        external_id: "view-1",
        name: "Valley lookout",
        kind: "viewpoint",
        lat: 46.56,
        lng: 10.5,
        distance_along_route_km: 96,
        distance_from_route_km: 0.1,
        website: null,
        phone: null,
        hint: "Panoramic stop",
      },
    ],
  },
];

describe("TripStopsPanel", () => {
  const useTripStopsMock = vi.mocked(useTripStops);

  beforeEach(() => {
    useTripStopsMock.mockReset();
    useTripStopsMock.mockReturnValue({
      days: dayStops,
      loading: false,
      error: null,
    });
    useTripStore.setState({
      trips: [],
      activeTrip: trip(),
      isGenerating: false,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      // Shared map-bar/STOPS filter state (revision 4 §A) — these tests
      // exercise the panel with all four along-route kinds active.
      activePoiCategories: new Set(["fuel", "food", "cafe", "viewpoint"]),
    });
  });

  it("drives the SHARED activePoiCategories set — the map POI bar reads the same slice", () => {
    render(<TripStopsPanel trip={useTripStore.getState().activeTrip} />);

    fireEvent.click(screen.getByLabelText("Viewpoints"));
    expect(useTripStore.getState().activePoiCategories.has("viewpoint")).toBe(
      false,
    );

    fireEvent.click(screen.getByLabelText("Viewpoints"));
    expect(useTripStore.getState().activePoiCategories.has("viewpoint")).toBe(
      true,
    );
  });

  it("shows overnight stays and along-route stops and lets riders add them", async () => {
    const activeTrip = useTripStore.getState().activeTrip;
    render(<TripStopsPanel trip={activeTrip} />);

    expect(useTripStopsMock).toHaveBeenCalledWith(activeTrip, {
      poiKinds: ["fuel_station", "restaurant", "cafe", "viewpoint"],
      minAccommodationStars: undefined,
    });
    expect(screen.getByText("Trip stops & stays")).toBeInTheDocument();
    expect(screen.getByText("Hotel Stelvio")).toBeInTheDocument();
    expect(screen.getByText("Shell Bormio")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Hotel Stelvio to day 1 itinerary",
      }),
    );

    await waitFor(() =>
      expect(useTripStore.getState().activeTrip?.days[0]?.waypoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "suggestion-accommodation-stay-1",
            name: "Hotel Stelvio",
            type: "accommodation",
          }),
        ]),
      ),
    );

    expect(
      screen.getByRole("button", {
        name: "Added Hotel Stelvio to day 1 itinerary",
      }),
    ).toBeDisabled();
  });

  it("inserts route-side stops before the day end waypoint", async () => {
    const activeTrip = useTripStore.getState().activeTrip;
    const originalGeometry = activeTrip?.days[0]?.routeGeometry;
    render(<TripStopsPanel trip={activeTrip} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Shell Bormio to day 1 itinerary",
      }),
    );

    await waitFor(() =>
      expect(useTripStore.getState().activeTrip?.days[0]?.waypoints).toEqual([
        expect.objectContaining({ id: "start", type: "start" }),
        expect.objectContaining({
          id: "suggestion-fuel_station-fuel-1",
          type: "fuel",
        }),
        expect.objectContaining({ id: "end", type: "end" }),
      ]),
    );

    expect(useTripStore.getState().activeTrip?.days[0]?.routeGeometry).toEqual(
      originalGeometry,
    );
  });

  it("refetches suggestions when riders narrow stay rating and poi types", async () => {
    const activeTrip = useTripStore.getState().activeTrip;
    render(<TripStopsPanel trip={activeTrip} />);

    fireEvent.change(screen.getByLabelText("Minimum stay rating"), {
      target: { value: "4" },
    });

    await waitFor(() =>
      expect(useTripStopsMock).toHaveBeenLastCalledWith(activeTrip, {
        poiKinds: ["fuel_station", "restaurant", "cafe", "viewpoint"],
        minAccommodationStars: 4,
      }),
    );

    fireEvent.click(screen.getByLabelText("Fuel stations"));

    await waitFor(() =>
      expect(useTripStopsMock).toHaveBeenLastCalledWith(activeTrip, {
        poiKinds: ["restaurant", "cafe", "viewpoint"],
        minAccommodationStars: 4,
      }),
    );
  });
});
