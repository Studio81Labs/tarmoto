import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import CommuteScreen, { __test } from "../CommuteScreen";
import type {
  CommuteAlternativeRoute,
  CommuteAlternativesResponse,
  CommuteRoute,
  CommuteStats,
  CommuteStatus,
} from "@/types";

const mockNavigate = jest.fn();
const mockAcknowledge = jest.fn();
const mockRetry = jest.fn();
const mockRefresh = jest.fn();
let mockSetPrimary = jest.fn();
let mockUseCommuteResult: ReturnType<typeof buildResult>;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock("@react-native-vector-icons/material-design-icons", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return function MockIcon({ name }: { name?: string }) {
    return ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  };
});

jest.mock("@/hooks/useCommute", () => ({
  useCommute: () => mockUseCommuteResult,
}));

const baseRoute: CommuteRoute = {
  id: "route-1",
  name: "Home → Work",
  origin: { lat: 49.2, lng: 16.6 },
  destination: { lat: 49.1, lng: 16.75 },
  distance_km: 12.5,
  avg_duration_min: 22,
  avg_quality: 4.2,
  is_primary: true,
  route_geometry: [],
};

const baseStatus: CommuteStatus = {
  route: baseRoute,
  hazards: [],
  weather: {
    temperature_c: 14,
    condition: "clear",
    wind_kmh: 8,
    precipitation_chance: 0.1,
    road_condition: "dry",
    description: "Clear and mild",
  },
  estimated_time_min: 22,
  route_quality: 4.2,
  status: "clear",
};

const baseAlternatives: CommuteAlternativesResponse = {
  primary_route: baseRoute,
  primary_hazard_count: 2,
  alternatives: [
    // Out-of-order so the ranker has work to do.
    {
      distance_km: 13.4,
      duration_min: 24,
      avg_quality: 3.8,
      hazard_count: 1,
      geometry: [],
    },
    {
      distance_km: 14.6,
      duration_min: 28,
      avg_quality: 4.4,
      hazard_count: 0,
      geometry: [],
    },
    {
      distance_km: 12.9,
      duration_min: 20,
      avg_quality: 3.5,
      hazard_count: 2,
      geometry: [],
    },
  ],
};

// Hand-picked totals so the rendered percentages are all distinct
// (distance +30%, time -20%, fuel +20%) — that lets the test target a
// specific cell without ambiguity from getByText().
const baseStats: CommuteStats = {
  period: "week",
  total_rides: 5,
  total_km: 65,
  total_time_min: 80,
  avg_duration_min: 16,
  fuel_estimate_l: 3,
  daily_breakdown: [],
  previous_period: {
    total_rides: 4,
    total_km: 50,
    total_time_min: 100,
    avg_duration_min: 25,
    fuel_estimate_l: 2.5,
  },
};

function buildResult(overrides: Partial<CommuteHookSnapshot> = {}) {
  return {
    phase: "ready" as const,
    route: baseRoute,
    savedRoutes: [baseRoute],
    status: baseStatus,
    hazards: [],
    newHazardCount: 0,
    alternatives: baseAlternatives,
    stats: baseStats,
    errorMessage: null,
    refresh: mockRefresh,
    retry: mockRetry,
    acknowledge: mockAcknowledge,
    setPrimary: mockSetPrimary,
    isRefreshing: false,
    isUpdatingPrimary: false,
    ...overrides,
  };
}

interface CommuteHookSnapshot {
  phase: "loading" | "learning" | "ready" | "error";
  route: CommuteRoute | null;
  savedRoutes: CommuteRoute[];
  status: CommuteStatus | null;
  hazards: never[];
  newHazardCount: number;
  alternatives: CommuteAlternativesResponse | null;
  stats: CommuteStats | null;
  errorMessage: string | null;
  refresh: jest.Mock;
  retry: jest.Mock;
  acknowledge: jest.Mock;
  setPrimary: jest.Mock;
  isRefreshing: boolean;
  isUpdatingPrimary: boolean;
}

describe("CommuteScreen", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockAcknowledge.mockReset();
    mockSetPrimary = jest.fn().mockResolvedValue(undefined);
    mockUseCommuteResult = buildResult();
  });

  it("starts a commute ride from the primary route CTA", () => {
    render(<CommuteScreen />);
    fireEvent.press(screen.getByLabelText("Start commute ride to Home → Work"));
    expect(mockNavigate).toHaveBeenCalledWith("RideTab", {
      screen: "RideActive",
      params: { rideType: "commute" },
    });
  });

  it("launches NavigationScreen with the primary route's polyline when the navigate button is tapped (#361)", () => {
    // Same `source: 'polyline'` discriminator the alternative cards use
    // (#342) — keeps the trip-day shim out of the commute hot path.
    const primaryGeometry = [
      { lat: 49.2, lng: 16.6 },
      { lat: 49.18, lng: 16.65 },
      { lat: 49.1, lng: 16.75 },
    ];
    const resolvedRoute: CommuteRoute = {
      ...baseRoute,
      route_geometry: primaryGeometry,
    };
    mockUseCommuteResult = buildResult({
      route: resolvedRoute,
      savedRoutes: [resolvedRoute],
      status: { ...baseStatus, route: resolvedRoute },
      alternatives: { ...baseAlternatives, primary_route: resolvedRoute },
    });

    render(<CommuteScreen />);

    fireEvent.press(
      screen.getByLabelText("Navigate primary commute route to Home → Work"),
    );

    expect(mockNavigate).toHaveBeenCalledWith("Navigate", {
      source: "polyline",
      polyline: primaryGeometry,
      title: "Home → Work",
    });
  });

  it("does not push Navigate when the primary route polyline has not been resolved yet (#361)", () => {
    // Backend lazily fills `route_geometry` after the first read; while
    // it's still null (fresh route, routing-provider outage) the nav
    // button should be disabled rather than push a dead Navigate.
    // `baseRoute.route_geometry` is `[]` in the fixture so the button
    // renders disabled and the tap is a no-op.
    render(<CommuteScreen />);

    fireEvent.press(
      screen.getByLabelText("Navigate primary commute route to Home → Work"),
    );

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("renders alternative routes ranked by hazards then duration", () => {
    render(<CommuteScreen />);

    // The ranker prioritises 0-hazard routes regardless of duration; among
    // hazard-tied entries, the shorter one wins. Resulting visual order
    // for the fixture is 14.6 km (CLEAR), 13.4 km (1 hazard), 12.9 km
    // (2 hazards). Asserting the rendered title order proves the
    // ranking flowed end-to-end.
    const rows = screen.getAllByText(/^\d+\.\d km · \d+ min$/);
    expect(rows.map((r) => r.props.children.join(""))).toEqual([
      "14.6 km · 28 min",
      "13.4 km · 24 min",
      "12.9 km · 20 min",
    ]);
  });

  it("starts a commute ride when a rider taps an alternative row", () => {
    render(<CommuteScreen />);
    // The first alternative row is the highest-ranked (14.6 km, CLEAR).
    fireEvent.press(
      screen.getByLabelText(/Start commute on alternative route, 14\.6/),
    );
    expect(mockNavigate).toHaveBeenCalledWith("RideTab", {
      screen: "RideActive",
      params: { rideType: "commute" },
    });
  });

  it("launches NavigationScreen with the alternative's polyline when the navigate button is tapped (#342)", () => {
    // Same fixture as `baseAlternatives` but with real geometry on the
    // first ranked alternative so the navigate button isn't disabled.
    // The screen passes the polyline straight through the new
    // `source: 'polyline'` discriminator — no trip-day shim required.
    const altGeometry = [
      { lat: 49.2, lng: 16.6 },
      { lat: 49.21, lng: 16.61 },
    ];
    mockUseCommuteResult = buildResult({
      alternatives: {
        ...baseAlternatives,
        alternatives: [
          {
            distance_km: 14.6,
            duration_min: 28,
            avg_quality: 4.4,
            hazard_count: 0,
            geometry: altGeometry,
          },
        ],
      },
    });

    render(<CommuteScreen />);

    fireEvent.press(
      screen.getByLabelText("Navigate alternative route, 14.6 kilometres"),
    );

    expect(mockNavigate).toHaveBeenCalledWith("Navigate", {
      source: "polyline",
      polyline: altGeometry,
      title: "Alternative · 14.6 km",
    });
  });

  it("does not crash when the navigate button is tapped on an alternative without geometry", () => {
    // Defensive: alternatives backend currently always returns geometry
    // but the new nav button is disabled when geometry has < 2 points
    // so a tap is a no-op (the rider sees the disabled state).
    render(<CommuteScreen />);

    // The base fixture has empty geometry on every alternative.
    fireEvent.press(
      screen.getByLabelText("Navigate alternative route, 14.6 kilometres"),
    );

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("surfaces an alert and clears the spinner when setPrimary rejects", async () => {
    const secondary: CommuteRoute = {
      ...baseRoute,
      id: "route-2",
      name: "Long way",
      is_primary: false,
    };
    mockSetPrimary = jest.fn().mockRejectedValue(new Error("Network down"));
    mockUseCommuteResult = buildResult({
      savedRoutes: [baseRoute, secondary],
      setPrimary: mockSetPrimary,
    });

    // Two Alert.alert invocations get fired: the initial confirmation
    // and (after the rejection) the "Couldn't update primary" error.
    // The mock auto-confirms the first and records the second so we
    // can assert on its title.
    const alertCalls: Array<[string, string | undefined]> = [];
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation((title, body, buttons) => {
        alertCalls.push([title, body]);
        if (title === "Use this as primary?") {
          const confirm = buttons?.find((b) => b.text === "Use as primary");
          confirm?.onPress?.();
        }
      });

    render(<CommuteScreen />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Use Long way as primary commute"));
      // Two flushes: one for the rejected setPrimary promise, one for
      // the chained `.finally()` setPendingId(null).
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSetPrimary).toHaveBeenCalledWith("route-2");
    // The error alert is the last call; the rider sees it instead of
    // a swallowed failure plus a ghost spinner.
    expect(alertCalls.map((c) => c[0])).toContain("Couldn't update primary");
    alertSpy.mockRestore();
  });

  it("calls setPrimary on the saved route after the rider confirms", async () => {
    const secondary: CommuteRoute = {
      ...baseRoute,
      id: "route-2",
      name: "Long way",
      is_primary: false,
    };
    mockUseCommuteResult = buildResult({
      savedRoutes: [baseRoute, secondary],
    });

    // Auto-confirm the alert's "Use as primary" button so the spec
    // exercises the full setPrimary path without a real prompt.
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation((_title, _body, buttons) => {
        const confirm = buttons?.find((b) => b.text === "Use as primary");
        confirm?.onPress?.();
      });

    render(<CommuteScreen />);

    // Wrap the press + microtask drain in act() because setPrimary
    // resolves asynchronously and triggers a setPendingId(null) state
    // update on completion. Without this, React 19 logs an act warning
    // and the assertion can race the state flush.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Use Long way as primary commute"));
      // Flush the setPrimary promise + the trailing setPendingId(null).
      await Promise.resolve();
    });

    expect(mockSetPrimary).toHaveBeenCalledWith("route-2");
    alertSpy.mockRestore();
  });

  it("renders the weekly summary trend with this-week vs last-week deltas", () => {
    render(<CommuteScreen />);
    expect(screen.getByText("This week")).toBeTruthy();
    // Each metric trends differently in the fixture so we can pin them
    // by exact percent label: distance 50→65 (+30%), time 100→80 (-20%),
    // fuel 2.5→3 (+20%). That proves the trendPercent helper actually
    // plumbed through to the cells, not just one happens to render.
    expect(screen.getByText("+30%")).toBeTruthy();
    expect(screen.getByText("-20%")).toBeTruthy();
    expect(screen.getByText("+20%")).toBeTruthy();
  });

  it("renders the rides delta as a whole number, not '+1.0'", () => {
    // Fixture has rides 4 → 5, so delta = 1. The Rides cell is the only
    // one that doesn't pass a `deltaText` percentage, so it falls back
    // to formatAbsDelta — which used to produce "+1.0" because of
    // toFixed(1). Asserting the integer form regression-guards that.
    render(<CommuteScreen />);
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByText("+1.0")).toBeNull();
  });

  it("renders a Δ time placeholder instead of NaN when the primary's avg_duration_min is null", () => {
    // Backend caches `avg_duration_min` on `CommuteRouteResponseDto` but
    // leaves it null until the routing provider resolves the route (and
    // on a provider outage). Without the guard, the alternative row's
    // Δ time chip would compute `alt.duration_min - null` = NaN and
    // render "NaN min" for every alternative — visibly broken UX. The
    // chip should fall back to "—" instead.
    const routeWithoutDuration: CommuteRoute = {
      ...baseRoute,
      avg_duration_min: null,
    };
    mockUseCommuteResult = buildResult({
      route: routeWithoutDuration,
      savedRoutes: [routeWithoutDuration],
      status: { ...baseStatus, route: routeWithoutDuration },
      alternatives: {
        ...baseAlternatives,
        primary_route: routeWithoutDuration,
      },
    });

    render(<CommuteScreen />);

    // Three alternative rows × one Δ time chip that depended on the
    // primary number = three placeholders. Assert no `NaN min` sneaks
    // through (Δ km still renders since distance is present).
    expect(screen.queryByText(/NaN min/)).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("does not expose a Start-on-tap affordance on saved (non-primary) routes", () => {
    // Tapping a saved route ONLY promotes it; "Start commute on …"
    // would have been a lie because RideActive uses whichever route
    // the backend treats as primary, not the row that was tapped.
    const secondary: CommuteRoute = {
      ...baseRoute,
      id: "route-2",
      name: "Long way",
      is_primary: false,
    };
    mockUseCommuteResult = buildResult({
      savedRoutes: [baseRoute, secondary],
    });

    render(<CommuteScreen />);

    expect(screen.queryByLabelText("Start commute on Long way")).toBeNull();
    expect(
      screen.getByLabelText("Use Long way as primary commute"),
    ).toBeTruthy();
  });
});

describe("rankAlternatives", () => {
  const make = (
    over: Partial<CommuteAlternativeRoute>,
  ): CommuteAlternativeRoute => ({
    distance_km: 10,
    duration_min: 20,
    avg_quality: 4,
    hazard_count: 0,
    geometry: [],
    ...over,
  });

  it("hazards beat duration: a 30-min clear route ranks above a 10-min hazard route", () => {
    const ranked = __test.rankAlternatives([
      make({ duration_min: 10, hazard_count: 2 }),
      make({ duration_min: 30, hazard_count: 0 }),
    ]);
    expect(ranked[0]?.hazard_count).toBe(0);
  });

  it("ties on hazards break by duration", () => {
    const ranked = __test.rankAlternatives([
      make({ duration_min: 25, hazard_count: 1 }),
      make({ duration_min: 18, hazard_count: 1 }),
    ]);
    expect(ranked[0]?.duration_min).toBe(18);
  });

  it("ties on hazards and duration break by quality (higher first)", () => {
    const ranked = __test.rankAlternatives([
      make({ avg_quality: 3.0 }),
      make({ avg_quality: 4.5 }),
    ]);
    expect(ranked[0]?.avg_quality).toBe(4.5);
  });

  it("treats null quality as worst", () => {
    const ranked = __test.rankAlternatives([
      make({ avg_quality: null }),
      make({ avg_quality: 2.0 }),
    ]);
    expect(ranked[0]?.avg_quality).toBe(2.0);
  });
});

describe("trendPercent", () => {
  it("returns a signed integer percentage above the rounding threshold", () => {
    expect(__test.trendPercent(60, 50)).toBe("+20%");
    expect(__test.trendPercent(40, 50)).toBe("-20%");
  });

  it("clamps tiny rounding noise to +/-0%", () => {
    expect(__test.trendPercent(50.001, 50)).toBe("±0%");
  });

  it("falls back to a neutral marker when there is no prior baseline", () => {
    expect(__test.trendPercent(0, 0)).toBe("±0%");
    expect(__test.trendPercent(5, 0)).toBe("+new");
  });
});
