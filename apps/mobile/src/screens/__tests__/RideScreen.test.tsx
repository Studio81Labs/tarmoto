import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import RideScreen from "../RideScreen";
import { api } from "@/services/api";
import type { RideSummary } from "@/types";

const mockNavigate = jest.fn();
const mockSetRecentRides = jest.fn();
let mockRecentRides: RideSummary[] = [];
let mockIsRiding = false;

jest.mock("@react-navigation/native", () => {
  const ReactLib = require("react");
  return {
    useNavigation: () => ({ navigate: mockNavigate }),
    // Mimic `useFocusEffect` semantics with a plain effect that runs on
    // mount (and on `cb` identity change). The screen wraps the
    // callback in `useCallback`, so its identity is stable per data
    // version; the tested behaviour is "fires on focus", which mount
    // covers.
    useFocusEffect: (cb: () => void) => {
      ReactLib.useEffect(() => cb(), [cb]);
    },
  };
});

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("@/services/api", () => ({
  api: {
    listRides: jest.fn(),
  },
}));

jest.mock("@/stores", () => ({
  useRideStore: (
    selector: (state: {
      recentRides: RideSummary[];
      setRecentRides: typeof mockSetRecentRides;
      isRiding: boolean;
      rideType: "free" | "commute" | "trip";
    }) => unknown,
  ) =>
    selector({
      recentRides: mockRecentRides,
      setRecentRides: mockSetRecentRides,
      isRiding: mockIsRiding,
      rideType: "free",
    }),
}));

describe("RideScreen", () => {
  const listMock = api.listRides as jest.MockedFunction<typeof api.listRides>;

  beforeEach(() => {
    listMock.mockReset();
    mockNavigate.mockReset();
    mockSetRecentRides.mockReset();
    mockRecentRides = [];
    mockIsRiding = false;
  });

  it("shows the empty state and starts a free ride from the CTA", async () => {
    listMock.mockResolvedValueOnce({ rides: [], total: 0 });

    await render(<RideScreen />);

    await waitFor(() => expect(screen.getByText(/no rides yet/i)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Start your first ride"));
    expect(mockNavigate).toHaveBeenCalledWith("RideActive", {
      rideType: "free",
    });
  });

  it("does not duplicate the start CTA when the history is empty", async () => {
    // Pre-fix bug: the FlatList rendered both the `ListHeader`'s
    // start card AND the `ListEmptyComponent`'s start CTA, stacking
    // two near-identical primary buttons. The header start card
    // must only appear when there's existing history (otherwise the
    // EmptyState provides the only CTA the rider needs).
    listMock.mockResolvedValueOnce({ rides: [], total: 0 });

    await render(<RideScreen />);

    await waitFor(() => expect(screen.getByText(/no rides yet/i)).toBeTruthy());
    expect(screen.queryByLabelText("Start a free ride")).toBeNull();
    // The empty state's CTA is the single visible Start button.
    expect(screen.getByLabelText("Start your first ride")).toBeTruthy();
  });

  it("hides the empty state mid-ride to avoid the misleading 'no rides yet' panel", async () => {
    mockIsRiding = true;
    listMock.mockResolvedValueOnce({ rides: [], total: 0 });

    await render(<RideScreen />);

    await waitFor(() =>
      expect(screen.getByLabelText("Return to active ride")).toBeTruthy(),
    );
    expect(screen.queryByText(/no rides yet/i)).toBeNull();
  });

  it("keeps the resume entry point visible when the history fetch fails mid-ride", async () => {
    // First-load offline is the typical case: the rider is already
    // in a live ride (e.g. they tapped Start, then opened the Ride
    // tab). A `/rides` failure must not lock them out of the active
    // HUD — the resume card stays visible above the error panel.
    mockIsRiding = true;
    listMock.mockRejectedValueOnce(new Error("offline"));

    await render(<RideScreen />);

    await waitFor(() =>
      expect(screen.getByText(/can't load rides/i)).toBeTruthy(),
    );
    expect(screen.getByLabelText("Return to active ride")).toBeTruthy();
  });

  it("renders the start card alongside the history list when there are past rides", async () => {
    mockRecentRides = [
      {
        id: "ride-1",
        ride_type: "free",
        status: "completed",
        started_at: "2026-04-17T14:32:00",
        ended_at: "2026-04-17T16:02:00",
        distance_km: 42.5,
        duration_min: 90,
        avg_speed: 45,
        avg_road_quality: 4.0,
        avg_curviness: null,
        name: null,
        max_lean_angle: null,
        bike_id: null,
      },
    ];
    listMock.mockResolvedValueOnce({ rides: mockRecentRides, total: 1 });

    await render(<RideScreen />);

    await waitFor(() => expect(screen.getByText(/42.5 km/)).toBeTruthy());
    expect(screen.getByLabelText("Start a free ride")).toBeTruthy();
    expect(screen.queryByText(/no rides yet/i)).toBeNull();
  });

  it("renders the cached history list and opens detail on tap", async () => {
    mockRecentRides = [
      {
        id: "ride-1",
        ride_type: "free",
        status: "completed",
        started_at: "2026-04-17T14:32:00",
        ended_at: "2026-04-17T16:02:00",
        distance_km: 42.5,
        duration_min: 90,
        avg_speed: 45,
        avg_road_quality: 4.0,
        avg_curviness: null,
        name: null,
        max_lean_angle: null,
        bike_id: null,
      },
    ];
    listMock.mockResolvedValueOnce({
      rides: mockRecentRides,
      total: 1,
    });

    await render(<RideScreen />);

    await waitFor(() => expect(screen.getByText(/42.5 km/)).toBeTruthy());
    expect(screen.getByText(/Apr 17, 2026/)).toBeTruthy();
    expect(screen.getByText(/1h 30m/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText(/Ride Apr 17, 2026/));
    expect(mockNavigate).toHaveBeenCalledWith("RideDetail", {
      rideId: "ride-1",
    });
  });
});
