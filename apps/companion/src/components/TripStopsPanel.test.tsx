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
    });
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
