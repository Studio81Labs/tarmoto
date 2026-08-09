import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InspectTab, daySurfaceMix } from "./InspectTab";
import { RouteQualityStrip } from "./RouteQualityStrip";
import { FormatProvider } from "@/format/FormatProvider";
import { deriveDayQualitySegments } from "@/lib/trip-planner-map";
import { deriveFlaggedSections } from "@/lib/planner/api";
import { coalesceQualityRuns } from "@/lib/planner/quality-bands";
import type { RouteSegment } from "@/lib/planner/types";
import type { TripDay } from "@/lib/types";

// Kill switches fail SAFE (enabled until a confirmed `force_off`); the real
// hook needs a QueryClientProvider this suite does not set up.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

function qualitySeg(over: Partial<RouteSegment>): RouteSegment {
  return {
    id: "d1-s0",
    geometry: {
      type: "LineString",
      coordinates: [
        [14.2, 49.4],
        [14.4, 49.42],
      ],
    },
    band: "good",
    surface: "asphalt",
    score: 4.2,
    passes: 20,
    lengthKm: 15,
    dayNumber: 1,
    ...over,
  };
}

function routedDay(overrides?: Partial<TripDay>): TripDay {
  return {
    dayNumber: 1,
    title: "Day one",
    distanceKm: 80.4,
    durationMinutes: 66,
    elevationGain: 900,
    avgQuality: 3.8,
    surfaceMix: { asphalt: 57_000, gravel: 23_400 },
    routeGeometry: {
      type: "LineString",
      coordinates: Array.from({ length: 30 }, (_, i) => [
        14.2 + i * 0.04,
        49.4 + Math.sin(i * 0.6) * 0.02,
      ]),
    },
    waypoints: [
      {
        id: "w-start",
        name: "Jihlava",
        location: { lng: 14.2, lat: 49.4 },
        type: "start",
      },
      {
        id: "w-via",
        name: "Velké Meziříčí",
        location: { lng: 14.8, lat: 49.42 },
        type: "via",
      },
      {
        id: "w-end",
        name: "Pardubice",
        location: { lng: 15.36, lat: 49.41 },
        type: "end",
      },
    ],
    ...overrides,
  };
}

describe("InspectTab", () => {
  it("uses the active distance unit in quality-strip accessible names", () => {
    render(
      <FormatProvider formatLocale="en-US" timeZone="UTC" units="imperial">
        <RouteQualityStrip segments={[qualitySeg({ lengthKm: 15 })]} />
      </FormatProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Preview Good or better section, 9.3 mi",
      }),
    ).toBeInTheDocument();
  });

  it("shows the empty state when no route exists yet", () => {
    render(
      <InspectTab
        day={null}
        selectedSegmentId={null}
        onInspectSegment={vi.fn()}
        onRerouteSegment={vi.fn()}
      />,
    );
    expect(screen.getByText(/Build a route first/)).toBeInTheDocument();
  });

  it("renders the route spine and real routing stats", () => {
    render(
      <InspectTab
        day={routedDay()}
        selectedSegmentId={null}
        onInspectSegment={vi.fn()}
        onRerouteSegment={vi.fn()}
      />,
    );

    expect(screen.getByText("Jihlava")).toBeInTheDocument();
    expect(screen.getByText("Velké Meziříčí")).toBeInTheDocument();
    expect(screen.getByText("Pardubice")).toBeInTheDocument();
    expect(screen.getByText("START")).toBeInTheDocument();
    expect(screen.getByText("VIA")).toBeInTheDocument();
    expect(screen.getByText("FINISH")).toBeInTheDocument();
    expect(screen.getByText("80.4")).toBeInTheDocument();
    expect(screen.getByText("3.8")).toBeInTheDocument();
    // Real surface mix from the routing response: 71% / 29%.
    expect(screen.getByText("71%").parentElement).toHaveTextContent(
      "71% Asphalt",
    );
    expect(screen.getByText("29%").parentElement).toHaveTextContent(
      "29% Gravel",
    );
  });

  it("opens a section preview from the quality strip", () => {
    const onInspectSegment = vi.fn();
    const day = routedDay();
    render(
      <InspectTab
        day={day}
        selectedSegmentId={null}
        onInspectSegment={onInspectSegment}
        onRerouteSegment={vi.fn()}
      />,
    );

    const [firstSection] = screen.getAllByRole("button", {
      name: /Preview .* section/,
    });
    fireEvent.click(firstSection!);
    // The strip coalesces adjacent same-band segments into runs, so the click
    // targets the whole run (id `run:<first>:<last>`), not the fine span.
    const firstRun = coalesceQualityRuns(deriveDayQualitySegments(day))[0]!;
    expect(onInspectSegment).toHaveBeenCalledWith(firstRun.id);
  });

  it("wires flagged-section cards to inspect and reroute", () => {
    // Stored real per-segment quality with both flag kinds — the Inspect tab
    // reads day.qualitySegments in preference to the no_data baseline (#862).
    const day = routedDay({
      qualitySegments: [
        qualitySeg({ id: "d1-s0", band: "good", score: 4.4, passes: 22 }),
        qualitySeg({
          id: "d1-s1",
          band: "rough",
          surface: "gravel",
          score: 2,
          passes: 5,
          lengthKm: 6.2,
        }),
        qualitySeg({
          id: "d1-s2",
          band: "no_data",
          surface: "unknown",
          score: null,
          passes: 0,
          lengthKm: 4.1,
        }),
      ],
    });
    const flags = deriveFlaggedSections(deriveDayQualitySegments(day));
    const rough = flags.find((f) => f.kind === "rough");
    const noData = flags.find((f) => f.kind === "no_data");
    if (!rough || !noData) throw new Error("fixture must flag both kinds");
    const roughLabel = "Rough · Gravel, 6.2 km";
    const noDataLabel = "No data yet · 4.1 km";

    const onInspectSegment = vi.fn();
    const onRerouteSegment = vi.fn();
    render(
      <InspectTab
        day={day}
        selectedSegmentId={null}
        onInspectSegment={onInspectSegment}
        onRerouteSegment={onRerouteSegment}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Reroute around flagged section: ${roughLabel}`,
      }),
    );
    expect(onRerouteSegment).toHaveBeenCalledWith(rough.segmentId);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Inspect flagged section: ${noDataLabel}`,
      }),
    );
    expect(onInspectSegment).toHaveBeenCalledWith(noData.segmentId);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Preview flagged section: ${roughLabel}`,
      }),
    );
    expect(onInspectSegment).toHaveBeenCalledWith(rough.segmentId);
  });
});

describe("daySurfaceMix", () => {
  it("prefers the real routing surface mix", () => {
    const day = routedDay();
    expect(daySurfaceMix(day, deriveDayQualitySegments(day))).toEqual([
      { surface: "asphalt", pct: 71 },
      { surface: "gravel", pct: 29 },
    ]);
  });

  it("falls back to segment-derived mix when the day has none", () => {
    const day = routedDay({ surfaceMix: undefined });
    const segments = deriveDayQualitySegments(day);
    const mix = daySurfaceMix(day, segments);
    expect(mix.length).toBeGreaterThan(0);
    expect(mix.reduce((sum, entry) => sum + entry.pct, 0)).toBeGreaterThan(95);
  });

  it("drops ONLY the quality sections when the overlay is killed", () => {
    // The tab mixes three features. Distance, duration and the surface mix are
    // not road-quality data, so a kill that took the whole tab down would
    // remove routing output the rider still needs to plan with.
    killSwitch.enabled = false;
    render(
      <InspectTab
        day={routedDay()}
        selectedSegmentId={null}
        onInspectSegment={vi.fn()}
        onRerouteSegment={vi.fn()}
      />,
    );

    // Gone: the quality strip, the "Quality /5" stat, and the flagged sections
    // (they are derived from measured quality — "Fair or better").
    expect(screen.queryByText(/road quality along route/i)).toBeNull();
    expect(screen.queryByText(/flagged section/i)).toBeNull();
    expect(screen.queryByText("Quality")).toBeNull();
    // 3.8 is the day's `avgQuality` — the score itself, not a routing stat.
    expect(screen.queryByText("3.8")).toBeNull();

    // Kept: the route spine and the non-quality routing stats.
    expect(screen.getByText("Jihlava")).toBeInTheDocument();
    expect(screen.getByText("80.4")).toBeInTheDocument();
    expect(screen.getByText(/surface mix/i)).toBeInTheDocument();
    expect(screen.getByText("71%").parentElement).toHaveTextContent(
      "71% Asphalt",
    );
  });
});
