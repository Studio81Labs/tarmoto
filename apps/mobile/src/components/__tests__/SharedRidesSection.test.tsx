/**
 * SharedRidesSection (#336) — fetches and renders the rider's shared
 * rides on the profile. The 404 path is the load-bearing piece: when
 * the backend hides a private rider's list, the section must render an
 * empty state rather than a scary error block.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

// `useFocusEffect` runs on every screen focus in the real navigator;
// mirror that semantic by re-running the callback whenever its identity
// changes (which happens when `userId` or `refreshKey` change).
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactLib = require("react");
    ReactLib.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === "function" ? cleanup : undefined;
    }, [cb]);
  },
}));

jest.mock("@/services/api", () => ({
  api: {
    listUserSharedRides: jest.fn(),
  },
  // Real subclass so the component's `err instanceof ApiError` narrows.
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

import SharedRidesSection from "../SharedRidesSection";
import { api, ApiError } from "@/services/api";

const mockedApi = api as jest.Mocked<typeof api>;

function buildRide(overrides: Record<string, unknown> = {}) {
  return {
    id: "ride-1",
    share_token: "tok-1",
    name: "Sunday switchbacks",
    ride_type: "free",
    is_public: true,
    started_at: "2026-04-14T09:00:00.000Z",
    ended_at: "2026-04-14T10:30:00.000Z",
    distance_km: 42.5,
    avg_speed: 65.3,
    avg_road_quality: 4.2,
    avg_curviness: 3.1,
    duration_min: 90,
    view_count: 7,
    shared_at: "2026-04-14T11:00:00.000Z",
    route_geometry: null,
    ...overrides,
  };
}

describe("SharedRidesSection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the rider's shared rides after fetch", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [buildRide()],
      total: 1,
      total_views: 7,
      limit: 5,
      offset: 0,
    });

    await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    await waitFor(() =>
      expect(mockedApi.listUserSharedRides).toHaveBeenCalledWith("user-2", {
        limit: 5,
      }),
    );
    expect(await screen.findByText("Shared rides")).toBeTruthy();
    // Distance + duration row is rendered from the helpers.
    expect(screen.getByText("42.5 km")).toBeTruthy();
    expect(screen.getByText("1h 30m")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("hides the private pill on other riders' profiles even if a private share leaked into the response", async () => {
    // Defensive — the backend already filters non-self viewers down to
    // public shares, but the UI shouldn't expose the private flag if it
    // ever sees one.
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [buildRide({ is_public: false })],
      total: 1,
      total_views: 7,
      limit: 5,
      offset: 0,
    });

    await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    await screen.findByText("42.5 km");
    expect(screen.queryByText("Private")).toBeNull();
  });

  it("shows the private pill for the rider's own private shares", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [buildRide({ is_public: false })],
      total: 1,
      total_views: 7,
      limit: 5,
      offset: 0,
    });

    await render(
      <SharedRidesSection userId="user-1" isSelf displayName="Me" />,
    );

    await screen.findByText("42.5 km");
    expect(screen.getByText("Private")).toBeTruthy();
  });

  it("shows a self empty hint when the rider has no shared rides", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      total_views: 0,
      limit: 5,
      offset: 0,
    });

    await render(
      <SharedRidesSection userId="user-1" isSelf displayName="Me" />,
    );

    expect(
      await screen.findByText("You haven't shared any rides yet."),
    ).toBeTruthy();
  });

  it("shows a third-person empty hint for other riders", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      total_views: 0,
      limit: 5,
      offset: 0,
    });

    await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByText("Other hasn't shared any rides yet."),
    ).toBeTruthy();
  });

  it("treats a 404 as 'no rides to show' rather than an error (private profile gate)", async () => {
    // The backend 404s for `profile_visibility = private` riders and
    // soft-deleted users — the section must render the empty state
    // instead of a scary error message.
    mockedApi.listUserSharedRides.mockRejectedValue(
      new ApiError("not found", 404, undefined),
    );

    await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByText("Other hasn't shared any rides yet."),
    ).toBeTruthy();
    // The error path must not have rendered any error copy.
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("surfaces non-404 failures as an inline error", async () => {
    mockedApi.listUserSharedRides.mockRejectedValue(new Error("offline"));

    await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(
      await screen.findByText("Could not load shared rides."),
    ).toBeTruthy();
  });

  it("re-fetches when refreshKey is bumped (parent pull-to-refresh nudge)", async () => {
    // Cursor Bugbot regression guard: before the fix this section only
    // fetched once on mount and stayed stale on pull-to-refresh.
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [buildRide()],
      total: 1,
      total_views: 7,
      limit: 5,
      offset: 0,
    });

    const { rerender } = await render(
      <SharedRidesSection
        userId="user-2"
        isSelf={false}
        displayName="Other"
        refreshKey={0}
      />,
    );

    await waitFor(() =>
      expect(mockedApi.listUserSharedRides).toHaveBeenCalledTimes(1),
    );

    await rerender(
      <SharedRidesSection
        userId="user-2"
        isSelf={false}
        displayName="Other"
        refreshKey={1}
      />,
    );

    await waitFor(() =>
      expect(mockedApi.listUserSharedRides).toHaveBeenCalledTimes(2),
    );
  });

  it("re-fetches when userId changes (e.g. ViewProfile navigates rider→rider)", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      total_views: 0,
      limit: 5,
      offset: 0,
    });

    const { rerender } = await render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="A" />,
    );

    await waitFor(() =>
      expect(mockedApi.listUserSharedRides).toHaveBeenCalledWith("user-2", {
        limit: 5,
      }),
    );

    await rerender(
      <SharedRidesSection userId="user-3" isSelf={false} displayName="B" />,
    );

    await waitFor(() =>
      expect(mockedApi.listUserSharedRides).toHaveBeenCalledWith("user-3", {
        limit: 5,
      }),
    );
  });
});
