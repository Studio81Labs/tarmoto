import { fireEvent, render, screen } from "@testing-library/react";
import { PassesPanel } from "./PassesPanel";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import type { PlannerClosureRoute } from "@/lib/closures-summary";

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

describe("PassesPanel", () => {
  const usePassesMock = vi.mocked(usePasses);
  const route: PlannerClosureRoute = {
    id: "day-1",
    label: "Day 1",
    points: [
      { lat: 46.5, lng: 10.4 },
      { lat: 46.6, lng: 10.5 },
    ],
  };

  beforeEach(() => {
    usePassesMock.mockReset();
    usePassesMock.mockReturnValue({
      passes: [],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    });
  });

  it("delegates month changes when used as a controlled component", () => {
    const onMonthChange = vi.fn();

    render(<PassesPanel month={7} onMonthChange={onMonthChange} />);

    fireEvent.change(screen.getByLabelText("Travel month"), {
      target: { value: "8" },
    });

    expect(onMonthChange).toHaveBeenCalledWith(8);
  });

  it("disables month changes when a value is forced without a change handler", () => {
    render(<PassesPanel month={7} />);

    expect(screen.getByLabelText("Travel month")).toBeDisabled();
  });

  it("surfaces route-level warnings for closed and unknown passes", () => {
    usePassesMock.mockReturnValue({
      passes: [],
      routePasses: [
        {
          id: "pass-1",
          name: "Stelvio Pass",
          country_code: "IT",
          region: "Lombardy",
          lat: 46.52,
          lng: 10.45,
          elevation_m: 2757,
          typical_open_month: 6,
          typical_close_month: 10,
          status: "closed",
          status_overridden: false,
          notes: "Closed until late May",
          last_updated: "2026-04-01T00:00:00Z",
        },
        {
          id: "pass-2",
          name: "Umbrail",
          country_code: "CH",
          region: "Graubunden",
          lat: 46.54,
          lng: 10.43,
          elevation_m: 2503,
          typical_open_month: 6,
          typical_close_month: 10,
          status: "unknown",
          status_overridden: true,
          notes: null,
          last_updated: "2026-04-02T00:00:00Z",
        },
      ],
      routeClosedCount: 1,
      routeUnknownCount: 1,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    });

    render(<PassesPanel month={3} routes={[route]} />);

    expect(
      screen.getByText(
        "Current trip crosses 1 closed pass and 1 unknown pass.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Stelvio Pass")).toBeInTheDocument();
    expect(screen.getByText("Umbrail")).toBeInTheDocument();
  });

  it("keeps route warnings tied to the selected travel month", () => {
    render(<PassesPanel month={9} routes={[route]} />);

    expect(usePassesMock).toHaveBeenCalledWith(9, [route], undefined);
  });

  it("reuses a stable empty routes reference when routes are omitted", () => {
    const { rerender } = render(<PassesPanel month={7} />);
    const firstRoutes = usePassesMock.mock.calls.at(-1)?.[1];

    rerender(<PassesPanel month={7} />);
    const secondRoutes = usePassesMock.mock.calls.at(-1)?.[1];

    expect(firstRoutes).toBe(secondRoutes);
  });

  it("reuses parent-loaded pass data without refetching", () => {
    const data: PassesQueryResult = {
      passes: [],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    };

    render(<PassesPanel month={7} data={data} />);

    expect(usePassesMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("No mountain passes seeded yet."),
    ).toBeInTheDocument();
  });

  it("can hide route warnings when used as a regional discovery panel", () => {
    render(<PassesPanel month={7} showRouteWarnings={false} />);

    expect(screen.queryByText("Route warnings")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Import or generate a route to check mountain pass crossings.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Seasonal passes")).toBeInTheDocument();
  });
});
