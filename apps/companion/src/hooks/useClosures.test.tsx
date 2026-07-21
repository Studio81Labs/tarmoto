import { render, screen, waitFor } from "@testing-library/react";
import { closuresApi } from "@/lib/api";
import type { PlannerClosureRoute } from "@/lib/closures-summary";
import { useClosures } from "./useClosures";
import { withQueryClient } from "./test-utils";

vi.mock("@/lib/api", () => ({
  closuresApi: {
    list: vi.fn(),
    checkRoute: vi.fn(),
  },
}));

function TestHarness({
  bbox,
  routes = [],
  enabled,
}: {
  bbox?: string;
  routes?: PlannerClosureRoute[];
  enabled?: boolean;
}) {
  const result = useClosures(7, routes, {
    bbox,
    ...(enabled !== undefined ? { enabled } : {}),
  });

  return (
    <div>
      <span>{result.loading ? "loading" : "loaded"}</span>
      <span>full={result.routeCounts.full}</span>
      <span>partial={result.routeCounts.partial}</span>
      <span>advisory={result.routeCounts.advisory}</span>
      <span>total={result.routeCounts.total}</span>
    </div>
  );
}

const route: PlannerClosureRoute = {
  id: "day-1",
  label: "Day 1",
  points: [
    { lat: 49.2, lng: 16.6 },
    { lat: 49.7, lng: 18.3 },
  ],
};

const secondRoute: PlannerClosureRoute = {
  id: "day-2",
  label: "Day 2",
  points: [
    { lat: 49.7, lng: 18.3 },
    { lat: 50.1, lng: 19.2 },
  ],
};

describe("useClosures", () => {
  beforeEach(() => {
    vi.mocked(closuresApi.list).mockReset();
    vi.mocked(closuresApi.checkRoute).mockReset();

    vi.mocked(closuresApi.list).mockResolvedValue({ data: [] } as never);
  });

  it("passes the viewport bbox into the public closures list query", async () => {
    render(<TestHarness bbox="17.557,49.644,18.963,49.996" />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
    });

    expect(closuresApi.list).toHaveBeenCalledWith(
      expect.objectContaining({
        active_on: expect.any(String),
        bbox: "17.557,49.644,18.963,49.996",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(closuresApi.checkRoute).not.toHaveBeenCalled();
  });

  it("does not fetch the list while disabled", async () => {
    render(<TestHarness bbox="17.5,49.6,18.9,49.9" enabled={false} />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("loaded")).toBeInTheDocument();
    });

    expect(closuresApi.list).not.toHaveBeenCalled();
  });

  it("uses one backend query for unique exact counts across route chunks", async () => {
    vi.mocked(closuresApi.checkRoute).mockResolvedValue({
      data: {
        closures: [],
        full_count: 103,
        partial_count: 17,
        advisory_count: 4,
      },
    } as Awaited<ReturnType<typeof closuresApi.checkRoute>>);

    render(<TestHarness routes={[route, secondRoute]} />, {
      wrapper: withQueryClient(),
    });

    await waitFor(() => {
      expect(screen.getByText("full=103")).toBeInTheDocument();
      expect(screen.getByText("partial=17")).toBeInTheDocument();
      expect(screen.getByText("advisory=4")).toBeInTheDocument();
      expect(screen.getByText("total=124")).toBeInTheDocument();
    });
    expect(closuresApi.checkRoute).toHaveBeenCalledTimes(1);
    expect(closuresApi.checkRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        route: route.points,
        additional_routes: [{ points: secondRoute.points }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
