import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { usePasses } from "./usePasses";
import { api, passesApi } from "@/lib/api";
import type { PlannerClosureRoute } from "@/lib/closures-summary";
import { withQueryClient } from "./test-utils";

vi.mock("@/lib/api", () => ({
  api: {
    GET: vi.fn(),
  },
  passesApi: {
    checkRoute: vi.fn(),
  },
}));

function TestHarness({
  bbox,
  routes,
  enabled,
}: {
  bbox?: string;
  routes?: PlannerClosureRoute[];
  enabled?: boolean;
}) {
  const result = usePasses(7, routes, {
    bbox,
    ...(enabled !== undefined ? { enabled } : {}),
  });

  return (
    <div>
      <span>{result.loading ? "loading" : "loaded"}</span>
      <span>{result.routeLoading ? "route-loading" : "route-idle"}</span>
      <span>closed={result.routeClosedCount}</span>
      <span>unknown={result.routeUnknownCount}</span>
      <span>{result.error ?? "no-error"}</span>
      <span>{result.routeError ?? "no-route-error"}</span>
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

const secondRoute: PlannerClosureRoute = {
  id: "day-2",
  label: "Day 2",
  points: [
    { lat: 46.6, lng: 10.5 },
    { lat: 46.7, lng: 10.6 },
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
    expect(() =>
      render(<TestHarness />, { wrapper: withQueryClient() }),
    ).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
      expect(screen.getByText("route-idle")).toBeInTheDocument();
    });

    expect(passesApi.checkRoute).not.toHaveBeenCalled();
  });

  it("passes the viewport bbox into the public passes list query", async () => {
    render(<TestHarness bbox="17.557,49.644,18.963,49.996" />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(api.GET).toHaveBeenCalledWith(
        "/api/v1/passes",
        expect.objectContaining({
          params: {
            query: {
              bbox: "17.557,49.644,18.963,49.996",
              for_month: 7,
              limit: 500,
              offset: 0,
            },
          },
        }),
      );
    });
  });

  it("loads every page instead of treating the server cap as a complete list", async () => {
    vi.mocked(api.GET)
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, id) => ({ id })),
        error: undefined,
      } as never)
      .mockResolvedValueOnce({
        data: [{ id: 500 }],
        error: undefined,
      } as never);

    render(<TestHarness bbox="5,45,17,49" />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(api.GET).toHaveBeenCalledTimes(2);
    });
    expect(api.GET).toHaveBeenLastCalledWith(
      "/api/v1/passes",
      expect.objectContaining({
        params: {
          query: expect.objectContaining({ limit: 500, offset: 500 }),
        },
      }),
    );
  });

  it("does not fetch the list while disabled", async () => {
    render(<TestHarness bbox="17.5,49.6,18.9,49.9" enabled={false} />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
    });

    expect(api.GET).not.toHaveBeenCalled();
  });

  it("hides uncataloged query diagnostics from rider-facing state", async () => {
    vi.mocked(api.GET).mockRejectedValue(new Error("socket exploded"));

    render(<TestHarness bbox="17.5,49.6,18.9,49.9" />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("Failed to load passes")).toBeInTheDocument();
    });
    expect(screen.queryByText("socket exploded")).not.toBeInTheDocument();
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

    const { rerender } = render(<TestHarness />, {
      wrapper: withQueryClient(),
    });

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

    const { rerender } = render(<TestHarness routes={[route]} />, {
      wrapper: withQueryClient(),
    });

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

  it("uses one backend query for unique exact counts across route chunks", async () => {
    vi.mocked(passesApi.checkRoute).mockResolvedValue({
      data: {
        closed_count: 237,
        unknown_count: 14,
        passes: [],
      },
    } as Awaited<ReturnType<typeof passesApi.checkRoute>>);

    render(<TestHarness routes={[route, secondRoute]} />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("closed=237")).toBeInTheDocument();
      expect(screen.getByText("unknown=14")).toBeInTheDocument();
    });
    expect(passesApi.checkRoute).toHaveBeenCalledTimes(1);
    expect(passesApi.checkRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        route: route.points,
        additional_routes: [{ points: secondRoute.points }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
