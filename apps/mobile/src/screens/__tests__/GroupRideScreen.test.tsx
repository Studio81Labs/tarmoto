import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import GroupRideScreen from "../GroupRideScreen";
import { ApiError, api } from "@/services/api";
import { useAuthStore } from "@/stores";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

// MapLibre native components don't run in jsdom; stub them to plain
// Views/no-ops so the "active" branch (unused by these gating tests, but
// still mounted at module scope) doesn't crash if ever rendered.
jest.mock("@maplibre/maplibre-react-native", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  function Pass(props: { children?: React.ReactNode }) {
    return ReactLib.createElement(View, null, props.children);
  }
  return {
    Map: Pass,
    Camera: () => null,
    Layer: () => null,
    GeoJSONSource: Pass,
  };
});

jest.mock("@/services/groupRideSocket", () => ({
  groupRideSocket: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    publishPosition: jest.fn(),
  },
}));

jest.mock("@/services/api", () => ({
  api: {
    createGroupRide: jest.fn(),
    joinGroupRide: jest.fn(),
    leaveGroupRide: jest.fn(),
    endGroupRide: jest.fn(),
    getGroupRide: jest.fn(),
  },
  // The screen narrows a stale-entitlement 403 with `err instanceof
  // ApiError`; the mock must expose a real constructor so `instanceof`
  // doesn't throw on the rejection built in the 403-net test below.
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

// Entitled by default so the pre-existing create/join UI keeps rendering
// once the screen gates the idle mode on `useFeature("group_rides")` /
// `useEntitlements()` (both back onto this real store) — see the
// "group_rides gating" describe block below for the locked/unresolved/403
// cases.
const ENTITLED_USER = {
  id: "u1",
  subscription_tier: "premium",
  features: { group_rides: true },
  limits: {},
};

describe("GroupRideScreen entitlement gating (#M2 group_rides)", () => {
  const createMock = api.createGroupRide as jest.MockedFunction<
    typeof api.createGroupRide
  >;
  const joinMock = api.joinGroupRide as jest.MockedFunction<
    typeof api.joinGroupRide
  >;

  beforeEach(() => {
    createMock.mockReset();
    joinMock.mockReset();
    useAuthStore.setState({ user: ENTITLED_USER as never });
  });

  afterEach(() => act(() => useAuthStore.setState({ user: null })));

  it("renders the normal create/join idle UI when resolved and entitled", async () => {
    await render(<GroupRideScreen />);

    expect(screen.getByText("Create a new group ride")).toBeTruthy();
    expect(screen.getByText("Join with a code")).toBeTruthy();
    expect(screen.queryByText("Group rides are a Premium feature")).toBeNull();
  });

  it("shows the locked upsell and never fires create/join when resolved and not entitled", async () => {
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { group_rides: false },
        limits: {},
      } as never,
    });

    await render(<GroupRideScreen />);

    expect(screen.getByText("Group rides are a Premium feature")).toBeTruthy();
    expect(screen.getByText("Group rides are a Premium feature.")).toBeTruthy();
    expect(screen.getByText("Upgrade required")).toBeTruthy();
    // The create/join entry forms must not render at all — a Free/Pro
    // rider gets the upsell instead of a form that would only 403.
    expect(screen.queryByText("Create a new group ride")).toBeNull();
    expect(screen.queryByText("Join with a code")).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(joinMock).not.toHaveBeenCalled();
  });

  it("dismissing the upgrade modal leaves the locked message on screen", async () => {
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "free",
        features: { group_rides: false },
        limits: {},
      } as never,
    });

    await render(<GroupRideScreen />);
    await fireEvent.press(screen.getByLabelText("Dismiss"));

    // No "back" from a bottom tab — the locked state must stay visible,
    // not unmount to a blank screen.
    expect(screen.getByText("Group rides are a Premium feature")).toBeTruthy();
    expect(screen.queryByText("Upgrade required")).toBeNull();
  });

  it("fails closed while the entitlement snapshot is unresolved — no paid UI, no upgrade prompt", async () => {
    // No `features`/`limits` slice at all (e.g. a legacy cached profile,
    // or the pre-first-refresh window) — `isResolved` must be false, not
    // "treat as entitled".
    useAuthStore.setState({
      user: { id: "u1", subscription_tier: "free" } as never,
    });

    await render(<GroupRideScreen />);

    expect(screen.queryByText("Create a new group ride")).toBeNull();
    expect(screen.queryByText("Join with a code")).toBeNull();
    expect(screen.queryByText("Group rides are a Premium feature")).toBeNull();
    expect(screen.queryByText("Upgrade required")).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(joinMock).not.toHaveBeenCalled();
  });

  it("opens the upgrade prompt on a stale-entitlement 403 from handleCreate", async () => {
    // A "pro" rider with a per-user override (rather than the default
    // premium fixture) so `upgradeTierForFeature` has a real target tier
    // and the modal reads "Upgrade required" — exercising the stale
    // snapshot / revoked-override scenario the reactive net exists for.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: { group_rides: true },
        limits: {},
      } as never,
    });
    createMock.mockRejectedValueOnce(
      new ApiError("Feature unavailable: group_rides", 403, {
        message: "Feature unavailable: group_rides",
      }),
    );

    await render(<GroupRideScreen />);
    await fireEvent.changeText(
      screen.getByPlaceholderText("e.g. Sunday Dolomites"),
      "Sunday Ride",
    );

    await act(async () => {
      await fireEvent.press(screen.getByText("Create"));
    });

    expect(createMock).toHaveBeenCalledWith("Sunday Ride");
    expect(screen.getByText("Group rides are a Premium feature.")).toBeTruthy();
    expect(screen.getByText("Upgrade required")).toBeTruthy();
    // Must not also fall through to the generic inline error banner.
    expect(screen.queryByText("Couldn't create the ride.")).toBeNull();
  });

  it("opens the upgrade prompt on a stale-entitlement 403 from handleJoin", async () => {
    // See the matching comment in the handleCreate test above.
    useAuthStore.setState({
      user: {
        id: "u1",
        subscription_tier: "pro",
        features: { group_rides: true },
        limits: {},
      } as never,
    });
    joinMock.mockRejectedValueOnce(
      new ApiError("Feature unavailable: group_rides", 403, {
        message: "Feature unavailable: group_rides",
      }),
    );

    await render(<GroupRideScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText("ABCDEF"), "ABCDEF");

    await act(async () => {
      await fireEvent.press(screen.getByText("Join"));
    });

    expect(joinMock).toHaveBeenCalledWith("ABCDEF");
    expect(screen.getByText("Group rides are a Premium feature.")).toBeTruthy();
    expect(screen.getByText("Upgrade required")).toBeTruthy();
    expect(screen.queryByText("Couldn't join that ride.")).toBeNull();
  });
});
