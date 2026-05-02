/**
 * SharedRidesSection (#336) — fetches and renders the rider's shared
 * rides on the profile. The 404 path is the load-bearing piece: when
 * the backend hides a private rider's list, the section must render an
 * empty state rather than a scary error block.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

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
      limit: 5,
      offset: 0,
    });

    render(
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
      limit: 5,
      offset: 0,
    });

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    await screen.findByText("42.5 km");
    expect(screen.queryByText("Private")).toBeNull();
  });

  it("shows the private pill for the rider's own private shares", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [buildRide({ is_public: false })],
      total: 1,
      limit: 5,
      offset: 0,
    });

    render(<SharedRidesSection userId="user-1" isSelf displayName="Me" />);

    await screen.findByText("42.5 km");
    expect(screen.getByText("Private")).toBeTruthy();
  });

  it("shows a self empty hint when the rider has no shared rides", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      limit: 5,
      offset: 0,
    });

    render(<SharedRidesSection userId="user-1" isSelf displayName="Me" />);

    expect(
      await screen.findByText("You haven't shared any rides yet."),
    ).toBeTruthy();
  });

  it("shows a third-person empty hint for other riders", async () => {
    mockedApi.listUserSharedRides.mockResolvedValue({
      items: [],
      total: 0,
      limit: 5,
      offset: 0,
    });

    render(
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

    render(
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

    render(
      <SharedRidesSection userId="user-2" isSelf={false} displayName="Other" />,
    );

    expect(await screen.findByText("offline")).toBeTruthy();
  });
});
