import { render, screen } from "@testing-library/react";
import { ClosuresPanel } from "./ClosuresPanel";
import { useClosures } from "@/hooks/useClosures";
import type { PlannerClosure } from "@/lib/closures-summary";

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

    expect(useClosuresMock).toHaveBeenCalledWith(7, []);
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
});
