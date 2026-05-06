import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TripPlannerPage from "./page";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import { useTripStore } from "@/stores/trip";
import {
  generateTripOptions,
  regenerateTripDay,
} from "@/lib/trip-itinerary-generator";
import { tripsApi } from "@/lib/api";
import type { Trip } from "@/lib/types";

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

const mockedTripPlannerMap = vi.fn((_props?: unknown) => (
  <div data-testid="trip-planner-map" />
));
const mockedPassesPanel = vi.fn((_props?: unknown) => (
  <div data-testid="passes-panel" />
));
const mockedClosuresPanel = vi.fn((_props?: unknown) => (
  <div data-testid="closures-panel" />
));
const mockedTripCollaborateModal = vi.fn((_props?: unknown) => null);

vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

vi.mock("@/stores/trip", () => ({
  useTripStore: vi.fn(),
}));

vi.mock("@/lib/trip-itinerary-generator", () => ({
  generateTripOptions: vi.fn(),
  regenerateTripDay: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/api", () => ({
  tripsApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    importRoute: vi.fn(),
    generate: vi.fn(),
  },
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

vi.mock("@/components/TripCollaborateModal", () => ({
  TripCollaborateModal: (props: unknown) => mockedTripCollaborateModal(props),
}));

function buildTrip(name: string): Trip {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    status: "draft",
    createdAt: "2026-04-23T09:00:00Z",
    updatedAt: "2026-04-23T09:00:00Z",
    collaborators: [],
    parameters: {
      days: 3,
      dailyKmTarget: 250,
      roadPreference: "mixed",
      surfacePreference: ["asphalt"],
      avoidHighways: true,
      avoidTolls: false,
      avoidUnpaved: true,
      minQuality: 3,
    },
    days: [
      {
        dayNumber: 1,
        title: "Day 1",
        distanceKm: 240,
        durationMinutes: 310,
        elevationGain: 1800,
        avgQuality: 4,
        overnightStop: {
          id: "stay-1",
          name: "Bormio",
          type: "accommodation",
          location: { lng: 10.37, lat: 46.47 },
        },
        routeGeometry: {
          type: "LineString",
          coordinates: [
            [10.37, 46.47],
            [10.57, 46.61],
          ],
        },
        waypoints: [
          {
            id: "wp-1",
            name: "Bormio",
            type: "start",
            location: { lng: 10.37, lat: 46.47 },
          },
          {
            id: "wp-2",
            name: "Prato allo Stelvio",
            type: "end",
            location: { lng: 10.57, lat: 46.61 },
          },
        ],
        segments: [],
      },
    ],
  };
}

type TripStoreSnapshot = {
  trips: Trip[];
  activeTrip: Trip | null;
  isGenerating: boolean;
  canUndo: boolean;
  canRedo: boolean;
  focusedSegmentId: string | null;
  hoveredSegmentId: string | null;
  undoStack: Array<Trip | null>;
  redoStack: Array<Trip | null>;
  setTrips: (trips: Trip[]) => void;
  setActiveTrip: (trip: Trip | null) => void;
  setGenerating: (isGenerating: boolean) => void;
  focusSegment: (segmentId: string | null) => void;
  hoverSegment: (segmentId: string | null) => void;
  addWaypoint: (dayIndex: number, waypoint: unknown) => void;
  appendPlannerWaypoint: (
    dayIndex: number,
    waypoint: unknown,
    parameters?: Trip["parameters"],
  ) => void;
  insertWaypointBeforeEnd: (dayIndex: number, waypoint: unknown) => void;
  removeWaypoint: (dayIndex: number, waypointId: string) => void;
  reorderWaypoints: (
    dayIndex: number,
    fromIndex: number,
    toIndex: number,
  ) => void;
  undo: () => void;
  redo: () => void;
};

describe("TripPlannerPage", () => {
  const useClosuresMock = vi.mocked(useClosures);
  const usePassesMock = vi.mocked(usePasses);
  const useTripStoreMock = vi.mocked(useTripStore);
  const generateTripOptionsMock = vi.mocked(generateTripOptions);
  const regenerateTripDayMock = vi.mocked(regenerateTripDay);
  const tripsApiCreateMock = vi.mocked(tripsApi.create);
  const tripsApiDeleteMock = vi.mocked(tripsApi.delete);
  const tripsApiGenerateMock = vi.mocked(tripsApi.generate);
  const tripsApiGetMock = vi.mocked(tripsApi.get);
  const tripsApiImportRouteMock = vi.mocked(tripsApi.importRoute);
  const tripsApiUpdateMock = vi.mocked(tripsApi.update);

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

  const setActiveTrip = vi.fn<(trip: Trip | null) => void>();
  const setGenerating = vi.fn<(isGenerating: boolean) => void>();
  const activeTrip = buildTrip("Best fit");
  const scenicTrip = buildTrip("Scenic sweep");
  const fastTrip = buildTrip("Fastest line");
  const importedTrip = buildTrip("Imported route");
  let storeState: TripStoreSnapshot;

  beforeEach(() => {
    mockedTripPlannerMap.mockClear();
    mockedPassesPanel.mockClear();
    mockedClosuresPanel.mockClear();
    mockedTripCollaborateModal.mockClear();
    mockPush.mockClear();
    setActiveTrip.mockReset();
    setGenerating.mockReset();
    useClosuresMock.mockReset();
    usePassesMock.mockReset();
    generateTripOptionsMock.mockReset();
    regenerateTripDayMock.mockReset();
    tripsApiCreateMock.mockReset();
    tripsApiDeleteMock.mockReset();
    tripsApiGenerateMock.mockReset();
    tripsApiGetMock.mockReset();
    tripsApiImportRouteMock.mockReset();
    tripsApiUpdateMock.mockReset();
    tripsApiCreateMock.mockResolvedValue({
      data: { id: "server-trip-1" },
    } as never);
    tripsApiDeleteMock.mockResolvedValue({ data: undefined } as never);
    tripsApiGenerateMock.mockResolvedValue({ data: {} } as never);
    tripsApiGetMock.mockResolvedValue({ data: {} } as never);
    tripsApiImportRouteMock.mockResolvedValue({
      data: { id: "imported-server-trip-1" },
    } as never);
    tripsApiUpdateMock.mockResolvedValue({
      data: { id: "server-trip-1" },
    } as never);
    setActiveTrip.mockImplementation((trip) => {
      storeState.activeTrip = trip;
    });
    setGenerating.mockImplementation((isGenerating) => {
      storeState.isGenerating = isGenerating;
    });
    storeState = {
      trips: [],
      activeTrip: null,
      isGenerating: false,
      canUndo: false,
      canRedo: false,
      focusedSegmentId: null,
      hoveredSegmentId: null,
      undoStack: [],
      redoStack: [],
      setTrips: vi.fn(),
      setActiveTrip,
      setGenerating,
      focusSegment: vi.fn(),
      hoverSegment: vi.fn(),
      addWaypoint: vi.fn(),
      appendPlannerWaypoint: vi.fn(),
      insertWaypointBeforeEnd: vi.fn(),
      removeWaypoint: vi.fn(),
      reorderWaypoints: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
    };
    useTripStoreMock.mockImplementation((selector) => selector(storeState));
    useClosuresMock.mockReturnValue(closuresData);
    usePassesMock.mockReturnValue(passesData);
    generateTripOptionsMock.mockReturnValue([
      {
        id: "best-fit",
        label: "Best fit",
        summary: "Balanced route",
        trip: activeTrip,
      },
      {
        id: "scenic",
        label: "Scenic sweep",
        summary: "More climbing",
        trip: scenicTrip,
      },
      {
        id: "fastest",
        label: "Fastest line",
        summary: "Lower transfer time",
        trip: fastTrip,
      },
    ]);
    regenerateTripDayMock.mockReturnValue({
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          title: "Regen day",
        },
      ],
    });
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
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("keeps placeholder timeline tabs non-interactive until a trip exists", () => {
    render(<TripPlannerPage />);

    expect(screen.getByRole("button", { name: /Day 1/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Day 2/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Day 3/i })).toBeDisabled();
    expect(mockedTripPlannerMap).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedDayNumber: 1,
      }),
    );
  });

  it("passes the live planner parameters into map-click waypoint creation", () => {
    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "180" },
    });
    fireEvent.change(screen.getByLabelText("Road preference"), {
      target: { value: "direct" },
    });
    fireEvent.click(screen.getByLabelText("Gravel"));
    fireEvent.click(screen.getByLabelText("Avoid highways"));
    fireEvent.click(screen.getByLabelText("Avoid tolls"));

    const latestMapProps = mockedTripPlannerMap.mock.calls.at(-1)?.[0] as
      | { onAddWaypoint?: (location: { lng: number; lat: number }) => void }
      | undefined;
    const onAddWaypoint = latestMapProps?.onAddWaypoint;

    expect(onAddWaypoint).toBeDefined();

    onAddWaypoint?.({ lng: 14.41, lat: 50.08 });

    expect(storeState.appendPlannerWaypoint).toHaveBeenCalledWith(
      0,
      {
        lng: 14.41,
        lat: 50.08,
      },
      {
        days: 5,
        dailyKmTarget: 180,
        roadPreference: "direct",
        surfacePreference: ["asphalt", "gravel"],
        avoidHighways: false,
        avoidTolls: true,
        avoidUnpaved: true,
        minQuality: 3,
      },
    );
  });

  it("generates itinerary options from the planner parameters and selects the best-fit trip", async () => {
    render(<TripPlannerPage />);

    fireEvent.change(screen.getByLabelText("Number of days"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Daily km target"), {
      target: { value: "320" },
    });
    fireEvent.click(screen.getByLabelText("Gravel"));
    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(generateTripOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          days: 4,
          dailyKmTarget: 320,
          surfacePreference: ["asphalt", "gravel"],
        }),
      ),
    );
    expect(setGenerating).toHaveBeenNthCalledWith(1, true);
    expect(setActiveTrip).toHaveBeenCalledWith(activeTrip);
    expect(setGenerating).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Scenic sweep")).toBeInTheDocument();
    expect(screen.getByText("Fastest line")).toBeInTheDocument();
  });

  it("regenerates a single day without replacing the whole itinerary", async () => {
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));

    fireEvent.click(screen.getByRole("button", { name: "Regenerate day 1" }));

    await waitFor(() =>
      expect(regenerateTripDayMock).toHaveBeenCalledWith(activeTrip, 1),
    );
    expect(setActiveTrip).toHaveBeenLastCalledWith(
      expect.objectContaining({
        days: [expect.objectContaining({ title: "Regen day" })],
      }),
    );
  });

  it("hides regenerate controls when the active trip no longer matches a generated option", async () => {
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));
    expect(
      screen.getByRole("button", { name: "Regenerate day 1" }),
    ).toBeInTheDocument();

    storeState.activeTrip = importedTrip;
    rerender(<TripPlannerPage />);

    expect(
      screen.queryByRole("button", { name: "Regenerate day 1" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the selected option snapshot aligned when the active trip is edited in place", async () => {
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));

    const editedTrip = {
      ...activeTrip,
      updatedAt: "2026-04-23T10:00:00Z",
      days: [
        {
          ...activeTrip.days[0]!,
          title: "Edited best fit",
        },
      ],
    };

    storeState.activeTrip = editedTrip;
    rerender(<TripPlannerPage />);

    setActiveTrip.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Scenic sweep/i }));
    expect(setActiveTrip).toHaveBeenCalledWith(scenicTrip);

    fireEvent.click(screen.getByRole("button", { name: /Best fit/i }));
    expect(setActiveTrip).toHaveBeenLastCalledWith(editedTrip);
  });

  it("clears the generated selection when the active trip is cleared", async () => {
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));
    expect(
      screen.getByRole("heading", { level: 1, name: "Best fit" }),
    ).toBeInTheDocument();

    storeState.activeTrip = null;
    rerender(<TripPlannerPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "New Trip" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Regenerate day 1" }),
    ).toBeNull();
  });

  it("ignores rapid repeat regenerate clicks while generation is already running", async () => {
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));

    const regenerateButton = screen.getByRole("button", {
      name: "Regenerate day 1",
    });
    fireEvent.click(regenerateButton);
    fireEvent.click(regenerateButton);

    await waitFor(() => expect(regenerateTripDayMock).toHaveBeenCalledTimes(1));
  });

  it("regenerates from the latest active trip snapshot after in-flight edits", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    setActiveTrip.mockClear();
    regenerateTripDayMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate day 1" }));

    const editedTrip = {
      ...activeTrip,
      updatedAt: "2026-04-23T10:15:00Z",
      days: [
        {
          ...activeTrip.days[0]!,
          title: "Edited while regenerating",
        },
      ],
    };

    storeState.activeTrip = editedTrip;
    rerender(<TripPlannerPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(regenerateTripDayMock).toHaveBeenCalledWith(editedTrip, 1);

    vi.useRealTimers();
  });

  it("ignores option switches while a day regeneration is in flight", async () => {
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));
    setActiveTrip.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate day 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Scenic sweep/ }));

    await waitFor(() => expect(regenerateTripDayMock).toHaveBeenCalledTimes(1));
    expect(setActiveTrip).not.toHaveBeenCalledWith(scenicTrip);
  });

  it("drops generated results when the active trip changes before generation finishes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    storeState.activeTrip = importedTrip;
    rerender(<TripPlannerPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(generateTripOptionsMock).toHaveBeenCalledTimes(1);
    expect(setActiveTrip).not.toHaveBeenCalledWith(activeTrip);
    expect(screen.queryByText("Scenic sweep")).not.toBeInTheDocument();
    expect(screen.getByText("Imported route")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("drops generated results when the active trip is edited in place before generation finishes", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    const editedTrip = {
      ...importedTrip,
      id: "best-fit",
      updatedAt: "2026-04-23T11:00:00Z",
      days: [
        {
          ...importedTrip.days[0]!,
          title: "Edited during generation",
        },
      ],
    };

    storeState.activeTrip = editedTrip;
    rerender(<TripPlannerPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(generateTripOptionsMock).toHaveBeenCalledTimes(1);
    expect(setActiveTrip).not.toHaveBeenCalledWith(activeTrip);
    expect(screen.queryByText("Scenic sweep")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Imported route" }),
    ).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("drops delayed generation callbacks after the planner unmounts", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(generateTripOptionsMock).not.toHaveBeenCalled();
    expect(setActiveTrip).not.toHaveBeenCalledWith(activeTrip);

    vi.useRealTimers();
  });

  it("still generates after StrictMode remounts the planner effect", async () => {
    vi.useFakeTimers();

    render(
      <StrictMode>
        <TripPlannerPage />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(generateTripOptionsMock).toHaveBeenCalledTimes(1);
    expect(setActiveTrip).toHaveBeenCalledWith(activeTrip);

    vi.useRealTimers();
  });

  it("drops delayed day regeneration callbacks after the planner unmounts", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    setActiveTrip.mockClear();
    regenerateTripDayMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate day 1" }));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(regenerateTripDayMock).not.toHaveBeenCalled();
    expect(setActiveTrip).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("shows a stable average-quality value for empty generated options", async () => {
    generateTripOptionsMock.mockReturnValueOnce([
      {
        id: "empty",
        label: "Empty option",
        summary: "No generated days",
        trip: {
          ...activeTrip,
          id: "empty-option",
          name: "Empty option",
          days: [],
        },
      },
    ]);

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Empty option" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("0.0/5")).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("saves the selected generated option to the backend", async () => {
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Fastest line/i })),
    );

    fireEvent.click(screen.getByRole("button", { name: /Fastest line/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiGenerateMock).toHaveBeenCalledWith(
        "server-trip-1",
        expect.objectContaining({
          option: "fastest",
        }),
      ),
    );
    expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1");
  });

  it("deletes a newly created metadata-only trip when route generation fails", async () => {
    tripsApiGenerateMock.mockRejectedValueOnce(new Error("route failed"));

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiDeleteMock).toHaveBeenCalledWith("server-trip-1"),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("sends a valid daily-km band when saving a short daily target", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        dailyKmTarget: 100,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          daily_km_min: 100,
          daily_km_max: 100,
        }),
      ),
    );
  });

  it("normalizes zero daily-km targets to the backend minimum instead of dropping them", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        dailyKmTarget: 0,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          daily_km_min: 1,
          daily_km_max: 1,
        }),
      ),
    );
  });

  it("blocks contradictory unpaved surface filters before creating a trip", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      parameters: {
        ...activeTrip.parameters,
        surfacePreference: ["gravel"],
        avoidUnpaved: true,
      },
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Select at least one paved surface or turn off Avoid unpaved roads before saving.",
      ),
    ).toBeInTheDocument();
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
  });

  it("does not save or redirect when the trip has no start waypoint", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      days: [
        {
          ...activeTrip.days[0]!,
          waypoints: [],
        },
      ],
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Add a start waypoint before saving this trip."),
    ).toBeInTheDocument();
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("preserves imported route geometry when saving an imported draft", async () => {
    storeState.activeTrip = {
      ...activeTrip,
      id: "imported-123",
      name: "Passo loop import",
      importSourceFormat: "kml",
      days: [
        {
          ...activeTrip.days[0]!,
          routeGeometry: {
            type: "LineString",
            coordinates: [
              [10.37, 46.47],
              [10.45, 46.55],
              [10.57, 46.61],
            ],
          },
          waypoints: [
            {
              id: "wp-start",
              name: "Bormio",
              type: "start",
              location: { lng: 10.37, lat: 46.47 },
            },
            {
              id: "wp-via",
              name: "Umbrail",
              type: "photo",
              location: { lng: 10.45, lat: 46.55 },
            },
            {
              id: "wp-end",
              name: "Prato allo Stelvio",
              type: "end",
              location: { lng: 10.57, lat: 46.61 },
            },
          ],
        },
      ],
    };

    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiImportRouteMock).toHaveBeenCalledWith({
        title: "Passo loop import",
        source_format: "kml",
        geometry: [
          { lng: 10.37, lat: 46.47 },
          { lng: 10.45, lat: 46.55 },
          { lng: 10.57, lat: 46.61 },
        ],
        waypoints: [
          { lng: 10.37, lat: 46.47, name: "Bormio" },
          { lng: 10.45, lat: 46.55, name: "Umbrail", type: "photo" },
          { lng: 10.57, lat: 46.61, name: "Prato allo Stelvio" },
        ],
      }),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/trips/imported-server-trip-1");
  });

  it("keeps the save button disabled after successful save while navigation is pending", async () => {
    render(<TripPlannerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Generate itinerary" }));

    await waitFor(() => expect(setActiveTrip).toHaveBeenCalledWith(activeTrip));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/trips/server-trip-1"),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("updates the promoted server trip instead of creating a duplicate draft", async () => {
    const promotedTripId = "11111111-2222-4333-8444-555555555555";
    tripsApiUpdateMock.mockResolvedValueOnce({
      data: { id: promotedTripId },
    } as never);
    storeState.activeTrip = activeTrip;

    render(<TripPlannerPage />);

    const latestModalProps = mockedTripCollaborateModal.mock.calls.at(
      -1,
    )?.[0] as { onPromoted?: (tripId: string) => void } | undefined;

    await act(async () => {
      latestModalProps?.onPromoted?.(promotedTripId);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tripsApiUpdateMock).toHaveBeenCalledWith(
        promotedTripId,
        expect.any(Object),
      ),
    );
    expect(tripsApiCreateMock).not.toHaveBeenCalled();
    expect(tripsApiGenerateMock).toHaveBeenCalledWith(
      promotedTripId,
      expect.objectContaining({ option: undefined }),
    );
    expect(mockPush).toHaveBeenCalledWith(`/trips/${promotedTripId}`);
  });
});
