import { render, screen, waitFor } from "@testing-library/react";
import { closuresApi } from "@/lib/api";
import { useClosures } from "./useClosures";
import { withQueryClient } from "./test-utils";

vi.mock("@/lib/api", () => ({
  closuresApi: {
    list: vi.fn(),
    checkRoute: vi.fn(),
  },
}));

function TestHarness({ bbox }: { bbox?: string }) {
  const result = useClosures(7, [], { bbox });

  return <div>{result.loading ? "loading" : "loaded"}</div>;
}

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
});
