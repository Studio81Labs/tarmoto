import { render, screen } from "@testing-library/react";
import TripPlannerPage from "./page";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripStore } from "@/stores/trip";

const mockedTripPlannerMap = vi.fn((_props?: unknown) => (
  <div data-testid="trip-planner-map" />
));
const mockedPassesPanel = vi.fn((_props?: unknown) => (
  <div data-testid="passes-panel" />
));
const mockedClosuresPanel = vi.fn((_props?: unknown) => (
  <div data-testid="closures-panel" />
));

vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

vi.mock("@/stores/trip", () => ({
  useTripStore: vi.fn(),
}));

vi.mock("@/lib/closures-summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/closures-summary")>(
    "@/lib/closures-summary",
  );
  return {
    ...actual,
    buildTripClosureRoutes: vi.fn(() => [
      {
        id: "day-1",
        label: "Day 1 · Demo",
        points: [
          { lat: 50.08, lng: 14.41 },
          { lat: 50.19, lng: 14.61 },
        ],
      },
    ]),
  };
});

vi.mock("@/components/TripPlannerMap", () => ({
  TripPlannerMap: (props: unknown) => mockedTripPlannerMap(props),
}));

vi.mock("@/components/PassesPanel", () => ({
  PassesPanel: (props: unknown) => mockedPassesPanel(props),
}));

vi.mock("@/components/ClosuresPanel", () => ({
  ClosuresPanel: (props: unknown) => mockedClosuresPanel(props),
}));

vi.mock("@/components/SegmentSidebar", () => ({
  SegmentSidebar: () => <div data-testid="segment-sidebar" />,
}));

vi.mock("@/components/TripStopsPanel", () => ({
  TripStopsPanel: () => <div data-testid="trip-stops-panel" />,
}));

vi.mock("@/components/TripExportMenu", () => ({
  TripExportMenu: () => <div data-testid="trip-export-menu" />,
}));

vi.mock("@/components/TripImportDialog", () => ({
  TripImportDialog: () => null,
}));

describe("TripPlannerPage", () => {
  const useClosuresMock = vi.mocked(useClosures);
  const usePassesMock = vi.mocked(usePasses);
  const useTripStoreMock = vi.mocked(useTripStore);

  const closuresData: ClosuresQueryResult = {
    closures: [],
    routeClosures: [],
    counts: { full: 0, partial: 0, advisory: 0, total: 0 },
    routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
    loading: false,
    routeLoading: false,
    error: null,
    routeError: null,
    previewDate: new Date("2026-07-15T12:00:00Z"),
  };

  const passesData: PassesQueryResult = {
    passes: [],
    routePasses: [],
    routeClosedCount: 0,
    routeUnknownCount: 0,
    loading: false,
    routeLoading: false,
    error: null,
    routeError: null,
  };

  beforeEach(() => {
    mockedTripPlannerMap.mockClear();
    mockedPassesPanel.mockClear();
    mockedClosuresPanel.mockClear();
    useClosuresMock.mockReset();
    usePassesMock.mockReset();
    useTripStoreMock.mockImplementation((selector) =>
      selector({
        trips: [],
        activeTrip: null,
        isGenerating: false,
        focusedSegmentId: null,
        hoveredSegmentId: null,
        setTrips: vi.fn(),
        setActiveTrip: vi.fn(),
        setGenerating: vi.fn(),
        focusSegment: vi.fn(),
        hoverSegment: vi.fn(),
        addWaypoint: vi.fn(),
        insertWaypointBeforeEnd: vi.fn(),
        removeWaypoint: vi.fn(),
        reorderWaypoints: vi.fn(),
      }),
    );
    useClosuresMock.mockReturnValue(closuresData);
    usePassesMock.mockReturnValue(passesData);
  });

  it("fetches planner conditions once and shares the results with the map and sidebar panels", () => {
    render(<TripPlannerPage />);

    expect(screen.getByTestId("trip-planner-map")).toBeInTheDocument();
    expect(useClosuresMock).toHaveBeenCalledTimes(1);
    expect(usePassesMock).toHaveBeenCalledTimes(1);

    expect(mockedTripPlannerMap).toHaveBeenCalledWith(
      expect.objectContaining({
        month: expect.any(Number),
        closuresData,
        passesData,
      }),
    );
    expect(mockedClosuresPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: closuresData,
      }),
    );
    expect(mockedPassesPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: passesData,
      }),
    );
  });
});
