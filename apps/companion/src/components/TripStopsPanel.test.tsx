import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TripStopsPanel } from "./TripStopsPanel";
import { plannerApi } from "@/lib/planner/api";
import { poiApi, type StoredCorridorPoiSuggestion } from "@/lib/api";
import { fetchFunZonesInCorridor } from "@/lib/discover";
import { useTripStore } from "@/stores/trip";
import type { Trip } from "@/lib/types";

// The OSM corridor stops come from the store (`/poi/in-corridor`, #859); these
// tests drive that path via `getInCorridor`. The `mountain_pass` /
// `twisty_highlight` corridor now hits the passes + fun-zones sources (#865) —
// stub them to empty so they don't interfere here.
vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ...actual,
    poiApi: { ...actual.poiApi, getInCorridor: vi.fn() },
    passesApi: {
      ...actual.passesApi,
      checkRoute: vi.fn(async () => ({
        data: { passes: [], closed_count: 0, unknown_count: 0 },
      })),
    },
  };
});
vi.mock("@/lib/discover", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/discover")>();
  return { ...actual, fetchFunZonesInCorridor: vi.fn(async () => []) };
});

const getInCorridorMock = vi.mocked(poiApi.getInCorridor);
const HOTEL_KINDS = [
  "hotel",
  "motel",
  "guest_house",
  "hostel",
  "chalet",
  "apartment",
];

function corridorPoi(
  over: Partial<StoredCorridorPoiSuggestion>,
): StoredCorridorPoiSuggestion {
  return {
    id: "x",
    source: "osm",
    external_id: "osm:node:1",
    name: "X",
    kind: "fuel_station",
    lat: 49.5,
    lng: 15.9,
    website: null,
    phone: null,
    opening_hours: null,
    address_street: null,
    address_city: null,
    address_postcode: null,
    address_country: null,
    cuisine: null,
    brand: null,
    stars: null,
    osm_url: null,
    maps_url: "https://www.google.com/maps/search/?api=1&query=x",
    last_imported_at: "2026-07-06T00:00:00.000Z",
    distance_along_route_km: 0,
    distance_from_route_km: 0,
    ...over,
  };
}

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
    getInCorridorMock.mockReset();
    getInCorridorMock.mockImplementation(async ({ kinds }) => {
      const pois: StoredCorridorPoiSuggestion[] = [];
      const has = (k: string) => kinds?.includes(k) ?? false;
      if (has("fuel_station"))
        pois.push(
          corridorPoi({
            id: "fuel-vysocina-1",
            kind: "fuel_station",
            name: "MOL Žďár nad Sázavou",
            distance_along_route_km: 20,
            distance_from_route_km: 0.5,
          }),
        );
      if (has("viewpoint"))
        pois.push(
          corridorPoi({
            id: "view-vysocina-1",
            kind: "viewpoint",
            name: "Devět skal vista",
            distance_along_route_km: 55,
            distance_from_route_km: 0.3,
          }),
        );
      if (kinds?.some((k) => HOTEL_KINDS.includes(k)))
        pois.push(
          corridorPoi({
            id: "hotel-1",
            kind: "hotel",
            name: "Hotel Vysočina",
            stars: 3,
            distance_along_route_km: 30,
            distance_from_route_km: 0.5,
          }),
        );
      return { data: { buffer_km: 20, count: pois.length, pois } };
    });
    vi.mocked(fetchFunZonesInCorridor).mockReset();
    vi.mocked(fetchFunZonesInCorridor).mockResolvedValue([]);
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
    // The fun-zones corridor returns "Svratka esses" (~11 km off this line); the
    // client-side projection keeps it only once the corridor is wide enough.
    vi.mocked(fetchFunZonesInCorridor).mockResolvedValue([
      {
        id: "fz-svratka",
        name: "Svratka esses",
        composite_score: 88,
        road_count: 6,
        total_curve_km: 5,
        avg_quality: 4,
        best_season: "summer",
        boundary: [
          { lat: 49.61, lng: 16.19 },
          { lat: 49.63, lng: 16.21 },
        ],
      },
    ]);
    useTripStore.setState({
      activePoiCategories: new Set(["twisty_highlight"]),
    });
    render(<TripStopsPanel trip={trip()} />);

    // Svratka esses sit well off this line: outside 5 km...
    expect(
      await screen.findByText(
        /No twisty highlights stops within 5 km/,
        undefined,
        { timeout: 2000 },
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
