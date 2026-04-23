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
});
