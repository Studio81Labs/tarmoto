import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RoadSegmentPopover } from "./RoadSegmentPopover";
import { roadsApi } from "@/lib/api";
import type { RiddenSegment } from "@/lib/road-map-layer";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    roadsApi: { getSegmentDetail: vi.fn() },
  };
});

const getSegmentDetailMock = vi.mocked(roadsApi.getSegmentDetail);

function segment(overrides: Partial<RiddenSegment> = {}): RiddenSegment {
  return {
    id: "seg-1",
    last_ridden_at: "2026-05-30T10:00:00.000Z",
    last_quality_score: 4.0,
    ride_count: 4,
    ...overrides,
  };
}

describe("RoadSegmentPopover", () => {
  beforeEach(() => {
    getSegmentDetailMock.mockReset();
  });

  it("shows the personal stats immediately and the road name + distance after the fetch", async () => {
    getSegmentDetailMock.mockResolvedValueOnce({
      // length_m is the aggregated logical road; the popover shows the selected
      // segment's own length (segment_length_m), so the two differ here to prove
      // the tile reads the per-segment field.
      data: {
        road_name: "Plzeň → Praha sweepers",
        length_m: 500000,
        segment_length_m: 88900,
      },
    } as never);

    render(<RoadSegmentPopover segment={segment()} onClose={() => {}} />);

    // Personal stats from the RiddenSegment render up-front, before the fetch.
    expect(screen.getByText("4.0")).toBeInTheDocument(); // quality badge
    expect(screen.getByText("Good surface")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // rides
    // Default seam context (en/UTC, no FormatProvider) renders month-first,
    // unlike the retired en-GB `formatShortDate` ("30 May").
    expect(screen.getByText("May 30")).toBeInTheDocument();

    // Name + distance arrive from the segment-detail fetch.
    expect(
      await screen.findByText("Plzeň → Praha sweepers"),
    ).toBeInTheDocument();
    expect(screen.getByText(/88\.9\s*km/)).toBeInTheDocument();
    expect(getSegmentDetailMock).toHaveBeenCalledWith(
      "seg-1",
      expect.anything(),
    );
  });

  it("settles to a generic name when the detail fetch fails (no stuck spinner)", async () => {
    getSegmentDetailMock.mockRejectedValueOnce(new Error("boom"));

    render(<RoadSegmentPopover segment={segment()} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
    );
    // Personal stats still render even when enrichment fails.
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("fires onClose from the close button", async () => {
    getSegmentDetailMock.mockResolvedValueOnce({
      data: { road_name: "Road A", length_m: 1000 },
    } as never);
    const onClose = vi.fn();

    render(<RoadSegmentPopover segment={segment()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close road segment" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
