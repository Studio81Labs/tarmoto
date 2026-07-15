import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PassesPanel } from "./PassesPanel";
import { usePasses, type PassesQueryResult } from "@/hooks/usePasses";
import type { PlannerClosureRoute } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";

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

  it("delegates month changes when used as a controlled component", async () => {
    const onMonthChange = vi.fn();

    render(<PassesPanel month={7} onMonthChange={onMonthChange} />);

    // react-aria Select: open the trigger button, then click the option.
    fireEvent.click(screen.getByRole("button", { name: /travel month/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "August" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("option", { name: "August" }));

    expect(onMonthChange).toHaveBeenCalledWith(8);
  });

  it("disables month changes when a value is forced without a change handler", () => {
    render(<PassesPanel month={7} />);

    expect(
      screen.getByRole("button", { name: /travel month/i }),
    ).toBeDisabled();
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
    // Single grey no-data status (revision 6) — never a green all-clear.
    expect(
      screen.getByText("Pass data not available for this region yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No closed or unknown passes on your route."),
    ).toBeNull();
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

  it("only makes non-open regional pass rows focusable (open passes have no marker)", () => {
    const pass = (over: Partial<MountainPass>): MountainPass =>
      ({
        id: "x",
        name: "Placeholder",
        country_code: "CH",
        region: null,
        lat: 46.5,
        lng: 8.3,
        elevation_m: 2000,
        status: "closed",
        ...over,
      }) as unknown as MountainPass;
    const data: PassesQueryResult = {
      passes: [
        pass({ id: "closed-1", name: "Grimsel", status: "closed" }),
        pass({ id: "open-1", name: "Brenner", status: "open" }),
      ],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    };

    render(
      <PassesPanel
        month={7}
        data={data}
        showRouteWarnings={false}
        onFocusPass={vi.fn()}
      />,
    );

    // The closed pass is a "Show on map" button; the open pass is a plain row.
    expect(
      screen.getByRole("button", { name: /grimsel/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /brenner/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Brenner")).toBeInTheDocument();
  });

  it("makes open passes focusable when focusOpenPasses is set (/explore)", () => {
    const pass = (over: Partial<MountainPass>): MountainPass =>
      ({
        id: "x",
        name: "Placeholder",
        country_code: "CH",
        region: null,
        lat: 46.5,
        lng: 8.3,
        elevation_m: 2000,
        status: "closed",
        ...over,
      }) as unknown as MountainPass;
    const onFocusPass = vi.fn();
    const openPass = pass({ id: "open-1", name: "Brenner", status: "open" });
    const data: PassesQueryResult = {
      passes: [openPass],
      routePasses: [],
      routeClosedCount: 0,
      routeUnknownCount: 0,
      loading: false,
      routeLoading: false,
      error: null,
      routeError: null,
    };

    render(
      <PassesPanel
        month={7}
        data={data}
        showRouteWarnings={false}
        onFocusPass={onFocusPass}
        focusOpenPasses
      />,
    );

    // The explorer markers every pass, so the open pass is now a button too.
    const openButton = screen.getByRole("button", { name: /brenner/i });
    fireEvent.click(openButton);
    expect(onFocusPass).toHaveBeenCalledWith(openPass);
  });
});
