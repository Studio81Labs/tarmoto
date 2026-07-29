/**
 * #M3 — TripsScreen entitlement gating on `max_active_trips` (a Free-tier
 * limit: 1; Pro/Premium unlimited). These tests exercise the "New trip"
 * FAB directly: at/over the resolved cap it must block the mint and show
 * the upsell instead of navigating; under the cap (or unlimited) it must
 * navigate normally; while the limit snapshot is unresolved it must fail
 * closed (disabled FAB, no navigation, no prompt).
 */
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import TripsScreen from "../TripsScreen";
import { useAuthStore, useTripStore } from "@/stores";
import { setActiveFormatContext } from "@/format";
import type { TripSummary } from "@/types";

const mockNavigate = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  // Mount-only mirror of the real useFocusEffect — enough to fire
  // TripsScreen's initial trips/folders fetch.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactLib = require("react");
    ReactLib.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === "function" ? cleanup : undefined;
    }, []); // eslint-disable-line
  },
}));

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
    listTrips: jest.fn(),
    listTripFolders: jest.fn(),
  },
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

import { api } from "@/services/api";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";

const mockedApi = api as jest.Mocked<typeof api>;

function trip(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: overrides.id ?? "t1",
    owner_id: overrides.owner_id ?? "owner-1",
    title: overrides.title ?? `Trip ${overrides.id ?? "t1"}`,
    region: overrides.region ?? null,
    num_days: overrides.num_days ?? 3,
    status: overrides.status ?? "planned",
    member_count: overrides.member_count ?? 1,
    folder_id: overrides.folder_id ?? null,
    created_at: overrides.created_at ?? "2026-04-20T10:00:00Z",
    distance_km: overrides.distance_km ?? null,
    quality_avg: overrides.quality_avg ?? null,
    passes_count: overrides.passes_count ?? null,
    overview_geometry: overrides.overview_geometry ?? null,
  };
}

describe("TripsScreen entitlement gating (#M3 max_active_trips)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps the factory impl but a prior test's mockReturnValue
    // would leak, so re-assert the fail-SAFE default each test.
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
    mockedApi.listTripFolders.mockResolvedValue([]);
    setActiveFormatContext({ locale: "en", timeZone: "UTC", units: "metric" });
  });

  afterEach(() =>
    act(() => {
      useAuthStore.setState({ user: null });
      useTripStore.setState({ trips: [], activeTrip: null });
    }),
  );

  it("blocks the FAB at the resolved cap and shows the upgrade prompt instead of navigating", async () => {
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "t1", status: "planned", owner_id: "u1" }),
    ]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("Trip t1")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Plan a new trip"));

    expect(mockNavigate).not.toHaveBeenCalled();
    // Free's default cap (1) matches the tier default, so pro (unlimited)
    // is a real upgrade target — the modal titles "Upgrade required", not
    // the dead-end "Limit reached".
    expect(screen.getByText("Upgrade required")).toBeTruthy();
    expect(
      screen.getByText("Free riders can keep 1 active trip. Upgrade for more."),
    ).toBeTruthy();
  });

  it("navigates to TripCreate when under the cap (unlimited tier)", async () => {
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "t1", status: "planned" }),
    ]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: {},
        limits: { max_active_trips: null },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("Trip t1")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Plan a new trip"));

    expect(mockNavigate).toHaveBeenCalledWith("TripCreate");
    expect(screen.queryByText("Upgrade required")).toBeNull();
  });

  it("navigates for a Free rider whose only open trip was JOINED, not owned", async () => {
    // A trip the rider joined as a collaborator is owned by someone else and
    // occupies THAT owner's cap. The Free rider owns zero trips, so the FAB
    // must NOT block — mirrors the backend's owner-scoped cap.
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "theirs", status: "active", owner_id: "someone-else" }),
    ]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("Trip theirs")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Plan a new trip"));

    expect(mockNavigate).toHaveBeenCalledWith("TripCreate");
    expect(screen.queryByText("Upgrade required")).toBeNull();
  });

  it("navigates when under a finite cap because completed trips don't count", async () => {
    // Free's cap is 1, but the only existing trip is completed — that
    // frees up the slot, matching the backend's OPEN_TRIP_STATUSES.
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "t1", status: "completed" }),
    ]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("Trip t1")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Plan a new trip"));

    expect(mockNavigate).toHaveBeenCalledWith("TripCreate");
  });

  it("fails closed while the limit snapshot is unresolved — FAB disabled, no navigation, no prompt", async () => {
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "t1", status: "planned" }),
    ]);
    // No `limits` slice at all (legacy cached profile / pre-refresh
    // window) — `isResolved` must be false, never "treat as unlimited".
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("Trip t1")).toBeTruthy());

    const fab = screen.getByLabelText("Plan a new trip");
    expect(fab.props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(fab);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Upgrade required")).toBeNull();
    expect(screen.queryByText("Limit reached")).toBeNull();
  });

  it("disables the empty-state 'Plan a trip' CTA while the limit snapshot is unresolved", async () => {
    // With zero trips the empty state is the ONLY create affordance — if its
    // button stayed enabled while limits are unresolved (or a legacy profile
    // that never refreshes) it would silently no-op on tap. It must fail
    // closed just like the FAB.
    mockedApi.listTrips.mockResolvedValue([]);
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("No trips yet")).toBeTruthy());

    const createBtn = screen.getByLabelText("Plan a trip");
    expect(createBtn.props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(createBtn);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("enables the empty-state CTA once the limit resolves (zero trips, under cap)", async () => {
    mockedApi.listTrips.mockResolvedValue([]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("No trips yet")).toBeTruthy());

    const createBtn = screen.getByLabelText("Plan a trip");
    expect(createBtn.props.accessibilityState?.disabled).toBe(false);

    await fireEvent.press(createBtn);
    expect(mockNavigate).toHaveBeenCalledWith("TripCreate");
  });

  it("hides the plan/join affordances when trip_planning is operator-disabled (trips present)", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    mockedApi.listTrips.mockResolvedValue([
      trip({ id: "t1", status: "planned", owner_id: "u1" }),
    ]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    // Existing trips stay readable...
    await waitFor(() => expect(screen.getByText("Trip t1")).toBeTruthy());
    // ...but the planner mint/join entries are gone (create FAB + join row).
    expect(screen.queryByLabelText("Plan a new trip")).toBeNull();
    expect(
      screen.queryByLabelText("Join a trip with an invite code"),
    ).toBeNull();
  });

  it("hides the empty-state CTAs when trip_planning is operator-disabled (no trips)", async () => {
    (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
    mockedApi.listTrips.mockResolvedValue([]);
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: {},
        limits: { max_active_trips: 1 },
      } as never,
    });

    await render(<TripsScreen />);
    await waitFor(() => expect(screen.getByText("No trips yet")).toBeTruthy());
    expect(screen.queryByLabelText("Plan a trip")).toBeNull();
    expect(screen.queryByText("Join with invite code")).toBeNull();
  });
});
