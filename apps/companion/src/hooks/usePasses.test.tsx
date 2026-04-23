import { render, screen, waitFor } from "@testing-library/react";
import { usePasses } from "./usePasses";
import { api, passesApi } from "@/lib/api";
import type { PlannerClosureRoute } from "@/lib/closures-summary";

vi.mock("@/lib/api", () => ({
  api: {
    GET: vi.fn(),
  },
  passesApi: {
    checkRoute: vi.fn(),
  },
}));

function TestHarness({ routes }: { routes?: PlannerClosureRoute[] }) {
  const result = usePasses(7, routes);

  return (
    <div>
      <span>{result.loading ? "loading" : "loaded"}</span>
      <span>{result.routeLoading ? "route-loading" : "route-idle"}</span>
    </div>
  );
}

const route: PlannerClosureRoute = {
  id: "day-1",
  label: "Day 1",
  points: [
    { lat: 46.5, lng: 10.4 },
    { lat: 46.6, lng: 10.5 },
  ],
};

describe("usePasses", () => {
  beforeEach(() => {
    vi.mocked(api.GET).mockReset();
    vi.mocked(passesApi.checkRoute).mockReset();

    vi.mocked(api.GET).mockResolvedValue({
      data: [],
      error: undefined,
    } as never);
  });

  it("does not loop when routes are omitted", async () => {
    expect(() => render(<TestHarness />)).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });

    expect(passesApi.checkRoute).not.toHaveBeenCalled();
  });

  it("keeps route loading active on the first render after routes appear", async () => {
    let resolveRouteCheck:
      | ((value: Awaited<ReturnType<typeof passesApi.checkRoute>>) => void)
      | undefined;
    const routeCheck = new Promise<
      Awaited<ReturnType<typeof passesApi.checkRoute>>
    >((resolve) => {
      resolveRouteCheck = resolve;
    });
    vi.mocked(passesApi.checkRoute).mockReturnValue(routeCheck as never);

    const { rerender } = render(<TestHarness />);

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });

    rerender(<TestHarness routes={[route]} />);

    expect(screen.getByText("route-loading")).toBeInTheDocument();
    expect(screen.queryByText("route-idle")).not.toBeInTheDocument();

    resolveRouteCheck?.({
      data: {
        closed_count: 0,
        unknown_count: 0,
        passes: [],
      },
    } as Awaited<ReturnType<typeof passesApi.checkRoute>>);

    await waitFor(() => {
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });
  });

  it("does not re-check routes when only non-query metadata changes", async () => {
    vi.mocked(passesApi.checkRoute).mockResolvedValue({
      data: {
        closed_count: 0,
        unknown_count: 0,
        passes: [],
      },
    } as Awaited<ReturnType<typeof passesApi.checkRoute>>);

    const { rerender } = render(<TestHarness routes={[route]} />);

    await waitFor(() => {
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });

    expect(passesApi.checkRoute).toHaveBeenCalledTimes(1);

    rerender(
      <TestHarness
        routes={[
          {
            ...route,
            label: "Renamed day 1",
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });

    expect(passesApi.checkRoute).toHaveBeenCalledTimes(1);
  });
});
