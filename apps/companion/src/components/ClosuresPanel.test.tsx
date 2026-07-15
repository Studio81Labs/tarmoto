import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClosuresPanel } from "./ClosuresPanel";
import { useClosures, type ClosuresQueryResult } from "@/hooks/useClosures";
import type { PlannerClosure } from "@/lib/closures-summary";
import { usePreferencesStore } from "@/stores/preferences";

vi.mock("@/hooks/useClosures", () => ({
  useClosures: vi.fn(),
}));

function closure(
  overrides: Partial<PlannerClosure> & { id: string },
): PlannerClosure {
  const { id, ...rest } = overrides;
  return {
    id,
    title: "Bridge resurfacing",
    reason: "roadworks",
    severity: "partial",
    geometry: [
      { lat: 46.53, lng: 10.45 },
      { lat: 46.54, lng: 10.46 },
    ],
    detour: null,
    country_code: "IT",
    region: "South Tyrol",
    starts_at: "2026-07-01T00:00:00Z",
    ends_at: "2026-07-18T00:00:00Z",
    notes: null,
    source: "operator",
    created_by: null,
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    ...rest,
  };
}

describe("ClosuresPanel", () => {
  const useClosuresMock = vi.mocked(useClosures);

  beforeEach(() => {
    useClosuresMock.mockReset();
    window.localStorage.clear();
    usePreferencesStore.setState({ unitSystem: "metric" });
  });

  it("encourages route loading when there is no active route geometry yet", () => {
    useClosuresMock.mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(<ClosuresPanel month={7} routes={[]} />);

    expect(useClosuresMock).toHaveBeenCalledWith(7, [], undefined);
    expect(screen.getByText("Closures & roadworks")).toBeInTheDocument();
    expect(
      screen.getByText("Import or generate a route to check crossings."),
    ).toBeInTheDocument();
  });

  it("surfaces route-crossing warnings ahead of the broader monthly closure list", () => {
    useClosuresMock.mockReturnValue({
      closures: [
        closure({ id: "closure-1", severity: "full", title: "Rockfall" }),
        closure({ id: "closure-2", severity: "partial" }),
      ],
      routeClosures: [
        closure({ id: "closure-1", severity: "full", title: "Rockfall" }),
      ],
      counts: { full: 1, partial: 1, advisory: 0, total: 2 },
      routeCounts: { full: 1, partial: 0, advisory: 0, total: 1 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(
      <ClosuresPanel
        month={7}
        routes={[
          {
            id: "day-1",
            label: "Day 1 · Stelvio",
            points: [
              { lat: 46.53, lng: 10.45 },
              { lat: 46.54, lng: 10.46 },
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Current trip crosses 1 active closure."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Rockfall")).toHaveLength(2);
    expect(screen.getByText("1 full")).toBeInTheDocument();
    expect(screen.getByText("1 partial")).toBeInTheDocument();
  });

  it("keeps detected route closures visible when some route checks fail", () => {
    useClosuresMock.mockReturnValue({
      closures: [],
      routeClosures: [
        closure({ id: "closure-1", severity: "full", title: "Rockfall" }),
      ],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 1, partial: 0, advisory: 0, total: 1 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: "Some route segments could not be checked.",
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(
      <ClosuresPanel
        month={7}
        routes={[
          {
            id: "day-1",
            label: "Day 1 · Stelvio",
            points: [
              { lat: 46.53, lng: 10.45 },
              { lat: 46.54, lng: 10.46 },
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Current trip crosses 1 active closure."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Some route segments could not be checked."),
    ).toBeInTheDocument();
    expect(screen.getByText("Rockfall")).toBeInTheDocument();
  });

  it("surfaces detour details for roadworks closures that include a reroute", () => {
    useClosuresMock.mockReturnValue({
      closures: [
        closure({
          id: "closure-detour",
          title: "Bridge resurfacing",
          detour: [
            { lat: 0, lng: 0 },
            { lat: 0, lng: 0.01 },
            { lat: 0, lng: 0.02 },
          ],
        }),
      ],
      routeClosures: [],
      counts: { full: 0, partial: 1, advisory: 0, total: 1 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(<ClosuresPanel month={7} routes={[]} />);

    expect(
      screen.getByText("Detour available · approx. 2.2 km"),
    ).toBeInTheDocument();
  });

  it("uses the rider's imperial unit preference for detour distance", () => {
    window.localStorage.setItem("tarmoto:preferences:unit-system", "imperial");
    useClosuresMock.mockReturnValue({
      closures: [
        closure({
          id: "closure-detour",
          title: "Bridge resurfacing",
          detour: [
            { lat: 0, lng: 0 },
            { lat: 0, lng: 0.01 },
            { lat: 0, lng: 0.02 },
          ],
        }),
      ],
      routeClosures: [],
      counts: { full: 0, partial: 1, advisory: 0, total: 1 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(<ClosuresPanel month={7} routes={[]} />);

    expect(
      screen.getByText("Detour available · approx. 1.4 mi"),
    ).toBeInTheDocument();
  });

  it("reuses parent-loaded closure data without refetching", () => {
    const data: ClosuresQueryResult = {
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

    render(<ClosuresPanel month={7} routes={[]} data={data} />);

    expect(useClosuresMock).not.toHaveBeenCalled();
    // routes=[] hides the route box, so the single no-data status line
    // renders in the regional area (revision 6) — and it must NOT be the
    // green all-clear.
    expect(
      screen.getByText("Closure data not available for this region yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No active closures on your route.")).toBeNull();
  });

  it("can hide route warnings when used as a regional discovery panel", () => {
    useClosuresMock.mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(<ClosuresPanel month={7} routes={[]} showRouteWarnings={false} />);

    expect(screen.queryByText("Route warnings")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Import or generate a route to check crossings."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Closures & roadworks")).toBeInTheDocument();
  });
});

describe("ClosuresPanel three-state status (revision 6)", () => {
  const base = {
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
  const route = [
    {
      id: "day-1",
      label: "Day 1",
      points: [
        { lat: 50.0, lng: 14.4 },
        { lat: 49.2, lng: 16.6 },
      ],
    },
  ];

  it("no_data: empty source shows ONE grey unknown line, never a green all-clear", () => {
    render(<ClosuresPanel month={7} routes={route} data={base} />);

    expect(
      screen.getAllByText("Closure data not available for this region yet."),
    ).toHaveLength(1);
    expect(screen.queryByText("No active closures on your route.")).toBeNull();
    expect(
      screen.queryByText("No active closures for this month yet."),
    ).toBeNull();
  });

  it("clear: populated source with zero route hits earns the green line", () => {
    render(
      <ClosuresPanel
        month={7}
        routes={route}
        data={{
          ...base,
          closures: [
            {
              id: "c1",
              title: "D1 modernisation",
              reason: "roadworks",
              severity: "partial",
              country_code: "CZ",
              region: null,
              starts_at: "2026-06-01T00:00:00Z",
              ends_at: null,
              notes: null,
              geometry: [
                { lat: 49.3, lng: 15.9 },
                { lat: 49.36, lng: 16.0 },
              ],
              detour: null,
              source: "operator" as const,
              created_by: null,
              created_at: "2026-06-01T00:00:00Z",
              updated_at: "2026-06-01T00:00:00Z",
            },
          ],
          counts: { full: 0, partial: 1, advisory: 0, total: 1 },
        }}
      />,
    );

    expect(
      screen.getByText("No active closures on your route."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Closure data not available for this region yet."),
    ).toBeNull();
  });
});

describe("ClosuresPanel on-route-only planner variant (revision 7)", () => {
  const onRouteClosure = {
    id: "c-route",
    title: "Resurfacing works",
    reason: "roadworks" as const,
    severity: "partial" as const,
    country_code: "CZ",
    region: null,
    starts_at: "2026-06-25T00:00:00Z",
    ends_at: "2026-08-19T00:00:00Z",
    notes: "Temporary signals.",
    geometry: [
      { lat: 49.5, lng: 18.2 },
      { lat: 49.52, lng: 18.25 },
    ],
    detour: [
      { lat: 49.5, lng: 18.2 },
      { lat: 49.51, lng: 18.21 },
      { lat: 49.52, lng: 18.25 },
    ],
    source: "operator" as const,
    created_by: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  };
  const data = {
    closures: [onRouteClosure],
    routeClosures: [onRouteClosure],
    counts: { full: 0, partial: 1, advisory: 0, total: 1 },
    routeCounts: { full: 0, partial: 1, advisory: 0, total: 1 },
    loading: false,
    routeLoading: false,
    error: null,
    routeError: null,
    previewDate: new Date("2026-07-15T12:00:00Z"),
  };
  const route = [
    {
      id: "day-1",
      label: "Day 1",
      points: [
        { lat: 49.49, lng: 18.18 },
        { lat: 49.53, lng: 18.3 },
      ],
    },
  ];

  it("hides the regional list and renders on-route cards with badge + reroute", () => {
    const onFocusClosure = vi.fn();
    const onRerouteClosure = vi.fn();
    render(
      <ClosuresPanel
        month={7}
        routes={route}
        data={data}
        showRegionalList={false}
        onFocusClosure={onFocusClosure}
        onRerouteClosure={onRerouteClosure}
      />,
    );

    // Regional tier is gone (the map owns ambient awareness now).
    expect(screen.queryByText(/1 partial/)).toBeNull();

    // The on-route card: badge, detour chip, reroute + focus actions.
    expect(screen.getByText("On route")).toBeInTheDocument();
    expect(screen.getByText(/Detour ~/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reroute around it/i }));
    expect(onRerouteClosure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c-route" }),
    );

    fireEvent.click(screen.getByTitle("Show on map"));
    expect(onFocusClosure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c-route" }),
    );
  });

  it("renders an inline preview-date picker and reports the noon-UTC date on change", async () => {
    vi.mocked(useClosures).mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });
    const onPreviewDateChange = vi.fn();

    render(
      <ClosuresPanel
        month={7}
        routes={[]}
        bbox="10,46,11,47"
        showRouteWarnings={false}
        onPreviewDateChange={onPreviewDateChange}
      />,
    );

    // The @tarmoto/ui DatePicker trigger carries the label + formatted value
    // in its accessible name.
    const trigger = screen.getByRole("button", { name: /preview date/i });
    await userEvent.click(trigger);
    await userEvent.click(
      screen.getByRole("button", { name: /July 20, 2026/ }),
    );
    // Anchored at noon UTC so any timezone parses the same calendar day.
    expect(onPreviewDateChange).toHaveBeenCalledWith(
      new Date(Date.UTC(2026, 6, 20, 12, 0, 0)),
    );
  });

  it("shows the read-only preview subtext when no date handler is supplied", () => {
    vi.mocked(useClosures).mockReturnValue({
      closures: [],
      routeClosures: [],
      counts: { full: 0, partial: 0, advisory: 0, total: 0 },
      routeCounts: { full: 0, partial: 0, advisory: 0, total: 0 },
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
      previewDate: new Date("2026-07-15T12:00:00Z"),
    });

    render(<ClosuresPanel month={7} routes={[]} showRouteWarnings={false} />);

    expect(screen.queryByLabelText("Preview date")).not.toBeInTheDocument();
    expect(screen.getByText(/Previewing/)).toBeInTheDocument();
  });
});
