import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { TripPlannerMap } from "./TripPlannerMap";
import type { Trip } from "@/lib/types";
import { createRegionDrawControl } from "@/components/map/RegionDrawControl";

const mockMap = {
  addSource: vi.fn(),
  getSource: vi.fn(),
  addLayer: vi.fn(),
  getLayer: vi.fn(),
  setPaintProperty: vi.fn(),
  fitBounds: vi.fn(),
} as const;

const drawControl = {
  start: vi.fn(),
  cancel: vi.fn(),
  clearDrawn: vi.fn(),
  setDrawn: vi.fn(),
  destroy: vi.fn(),
  getMode: vi.fn(() => "idle" as const),
};

let lastDrawOptions: {
  onRegionDrawn: (bbox: [number, number, number, number]) => void;
  onModeChange?: (mode: "idle" | "drawing") => void;
} | null = null;

vi.mock("@/components/map/MapCanvas", () => ({
  MapCanvas: forwardRef(function MockMapCanvas(
    props: {
      showQuality: boolean;
      showSurface: boolean;
      onReady?: (map: typeof mockMap) => void;
      children?: React.ReactNode;
    },
    ref: React.ForwardedRef<{ map: typeof mockMap | null }>,
  ) {
    useImperativeHandle(ref, () => ({
      map: mockMap,
    }));

    useEffect(() => {
      props.onReady?.(mockMap);
    }, [props]);

    return (
      <div
        data-testid="planner-map-canvas"
        data-show-quality={String(props.showQuality)}
        data-show-surface={String(props.showSurface)}
      >
        {props.children}
      </div>
    );
  }),
}));

vi.mock("@/components/map/RegionDrawControl", () => ({
  createRegionDrawControl: vi.fn((_map, options) => {
    lastDrawOptions = options;
    return drawControl;
  }),
}));

function trip(): Trip {
  return {
    id: "trip-1",
    name: "Planner test trip",
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
        title: "Day one",
        distanceKm: 120,
        durationMinutes: 180,
        elevationGain: 800,
        avgQuality: 4.1,
        waypoints: [
          {
            id: "start-1",
            name: "Start",
            location: { lng: 14.41, lat: 50.08 },
            type: "start",
          },
          {
            id: "end-1",
            name: "End",
            location: { lng: 14.61, lat: 50.19 },
            type: "end",
          },
        ],
      },
    ],
  };
}

describe("TripPlannerMap", () => {
  beforeEach(() => {
    vi.mocked(createRegionDrawControl).mockClear();
    lastDrawOptions = null;
    drawControl.start.mockReset();
    drawControl.cancel.mockReset();
    drawControl.clearDrawn.mockReset();
    drawControl.setDrawn.mockReset();
    drawControl.destroy.mockReset();
    drawControl.getMode.mockReturnValue("idle");
    mockMap.addSource.mockReset();
    mockMap.getSource.mockReset();
    mockMap.addLayer.mockReset();
    mockMap.getLayer.mockReset();
    mockMap.setPaintProperty.mockReset();
    mockMap.fitBounds.mockReset();
  });

  it("toggles the shared MapCanvas quality and surface overlays", () => {
    render(<TripPlannerMap trip={trip()} />);

    const canvas = screen.getByTestId("planner-map-canvas");
    expect(canvas).toHaveAttribute("data-show-quality", "true");
    expect(canvas).toHaveAttribute("data-show-surface", "false");

    fireEvent.click(
      screen.getByRole("button", { name: "Surface overlay off" }),
    );
    expect(canvas).toHaveAttribute("data-show-surface", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Road quality overlay on" }),
    );
    expect(canvas).toHaveAttribute("data-show-quality", "false");
  });

  it("surfaces rectangle drawing controls and lets riders clear a drawn region", () => {
    render(<TripPlannerMap trip={trip()} />);

    fireEvent.click(screen.getByRole("button", { name: "Draw region" }));
    expect(drawControl.start).toHaveBeenCalledTimes(1);

    act(() => {
      lastDrawOptions?.onModeChange?.("drawing");
    });
    expect(
      screen.getByRole("button", { name: "Cancel drawing" }),
    ).toBeInTheDocument();

    act(() => {
      lastDrawOptions?.onRegionDrawn([14.4, 50.08, 14.7, 50.3]);
      lastDrawOptions?.onModeChange?.("idle");
    });
    expect(
      screen.getByRole("button", { name: "Clear region" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear region" }));
    expect(drawControl.clearDrawn).toHaveBeenCalledTimes(1);
  });

  it("re-fits the map when trip bounds change on the same trip id", () => {
    const { rerender } = render(<TripPlannerMap trip={trip()} />);

    return waitFor(() => {
      expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    }).then(() => {
      mockMap.fitBounds.mockClear();

      rerender(
        <TripPlannerMap
          trip={{
            ...trip(),
            days: [
              {
                ...trip().days[0]!,
                waypoints: [
                  {
                    id: "start-1",
                    name: "Start",
                    location: { lng: 15.11, lat: 50.58 },
                    type: "start",
                  },
                  {
                    id: "end-1",
                    name: "End",
                    location: { lng: 15.61, lat: 50.79 },
                    type: "end",
                  },
                ],
              },
            ],
          }}
        />,
      );

      return waitFor(() => {
        expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
        expect(mockMap.fitBounds).toHaveBeenCalledWith(
          [
            [15.11, 50.58],
            [15.61, 50.79],
          ],
          expect.objectContaining({
            padding: 72,
            duration: 0,
            maxZoom: 11,
          }),
        );
      });
    });
  });

  it("destroys the previous draw control before reinitializing onReady", () => {
    const { rerender } = render(<TripPlannerMap trip={trip()} />);

    const initialCreateCalls = vi.mocked(createRegionDrawControl).mock.calls
      .length;
    const initialDestroyCalls = drawControl.destroy.mock.calls.length;

    rerender(<TripPlannerMap trip={trip()} />);

    expect(drawControl.destroy.mock.calls.length).toBe(initialDestroyCalls + 1);
    expect(vi.mocked(createRegionDrawControl).mock.calls.length).toBe(
      initialCreateCalls + 1,
    );
  });
});
