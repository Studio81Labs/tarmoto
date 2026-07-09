import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RoadPreviewPopover } from "./RoadPreviewPopover";
import { plannerApi } from "@/lib/planner/api";
import type { RoadPreview, RouteSegment } from "@/lib/planner/types";

vi.mock("@/lib/planner/api", () => ({
  plannerApi: { getRoadPreview: vi.fn(), getSegmentImagery: vi.fn() },
}));

const getRoadPreviewMock = vi.mocked(plannerApi.getRoadPreview);
const getSegmentImageryMock = vi.mocked(plannerApi.getSegmentImagery);

// Imagery now streams in via a separate call, merged onto the quality card.
// imageUrl is the backend thumb proxy (the browser never hits Mapillary).
const IMAGE = {
  imageUrl: "http://localhost:3000/api/v1/roads/segment-imagery/thumb/mly-1",
  imageCapturedAt: "2024-09-15",
  imageAttribution: "© rider · Mapillary (CC BY-SA)",
  imageLink: "https://www.mapillary.com/app/?pKey=mly-1",
};

function segment(overrides?: Partial<RouteSegment>): RouteSegment {
  return {
    id: "d1-s2",
    geometry: {
      type: "LineString",
      coordinates: [
        [15.0, 49.5],
        [15.05, 49.55],
        [15.1, 49.6],
      ],
    },
    band: "rough",
    surface: "gravel",
    score: 2.1,
    passes: 14,
    lengthKm: 4.2,
    dayNumber: 1,
    ...overrides,
  };
}

function measuredPreview(overrides?: Partial<RoadPreview>): RoadPreview {
  return {
    segmentId: "d1-s2",
    hasData: true,
    score: 2.1,
    band: "rough",
    surface: "gravel",
    passes: 14,
    // Real per-road-segment spans across a "rough" run (score + length).
    microStrip: [
      { score: 2.1, lengthKm: 1.5 },
      { score: 1.9, lengthKm: 0.8 },
      { score: 2.4, lengthKm: 1.9 },
    ],
    ...overrides,
  };
}

describe("RoadPreviewPopover", () => {
  beforeEach(() => {
    getRoadPreviewMock.mockReset();
    getSegmentImageryMock.mockReset();
    getSegmentImageryMock.mockResolvedValue(IMAGE);
  });

  it("renders the measured state with score, passes, and micro strip", async () => {
    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    render(<RoadPreviewPopover segment={segment()} onClose={vi.fn()} />);

    expect(await screen.findByText("2.1")).toBeInTheDocument();
    expect(screen.getByText("Rough")).toBeInTheDocument();
    expect(screen.getByText(/based on/)).toBeInTheDocument();
    expect(screen.getByText(/14/)).toBeInTheDocument();
    expect(screen.getByText("QUALITY ACROSS SECTION")).toBeInTheDocument();
    expect(screen.getByText(/captured/i)).toBeInTheDocument();
    expect(screen.getByText("Sep 2024", { exact: false })).toBeInTheDocument();
    // Real image loaded through the backend proxy (not Mapillary's CDN).
    expect(
      screen.getByRole("img", { name: /street-level preview/i }),
    ).toHaveAttribute("src", IMAGE.imageUrl);
    // The CC-BY-SA credit is a LINK back to the Mapillary image page.
    const credit = screen.getByRole("link", {
      name: /Mapillary \(CC BY-SA\)/,
    });
    expect(credit).toHaveAttribute("href", IMAGE.imageLink);
    expect(
      screen.getByRole("link", { name: /Google Street View/ }),
    ).toBeInTheDocument();
  });

  it("shows a graceful empty state when there is no imagery coverage", async () => {
    // The Mapillary lookup found no coverage.
    getSegmentImageryMock.mockResolvedValue(null);
    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    render(<RoadPreviewPopover segment={segment()} onClose={vi.fn()} />);

    // Score + strip still render; the imagery slot reads as "no imagery",
    // not a fake capture date.
    expect(await screen.findByText("2.1")).toBeInTheDocument();
    expect(screen.getByText("QUALITY ACROSS SECTION")).toBeInTheDocument();
    expect(screen.getByText(/NO STREET IMAGERY/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/captured/i)).not.toBeInTheDocument();
  });

  it("dims the score and shows the low-confidence note at ≤3 passes", async () => {
    getRoadPreviewMock.mockResolvedValue(measuredPreview({ passes: 2 }));
    render(
      <RoadPreviewPopover segment={segment({ passes: 2 })} onClose={vi.fn()} />,
    );

    expect(await screen.findByText(/LOW CONFIDENCE/)).toBeInTheDocument();
    expect(screen.getByText(/2 PASSES/)).toBeInTheDocument();
    expect(screen.getByText(/treat this as provisional/i)).toBeInTheDocument();
    expect(screen.queryByText(/based on/)).not.toBeInTheDocument();
  });

  it("renders the no-data state with the unverified OSM tag", async () => {
    getRoadPreviewMock.mockResolvedValue({
      segmentId: "d1-s2",
      hasData: false,
      surface: "unknown",
      passes: 0,
      osmSurfaceTag: "asphalt",
    });
    render(
      <RoadPreviewPopover
        segment={segment({ band: "no_data", score: null, passes: 0 })}
        onClose={vi.fn()}
        onReroute={vi.fn()}
      />,
    );

    expect(await screen.findByText("surface = asphalt")).toBeInTheDocument();
    expect(screen.getByText(/· unverified/)).toBeInTheDocument();
    expect(screen.getByText(/MAPILLARY · CAPTURED/)).toBeInTheDocument();
    expect(screen.getByText(/be the first to map it/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Keep in route/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("QUALITY ACROSS SECTION"),
    ).not.toBeInTheDocument();
  });

  it("closes via the header button, the backdrop, and Keep anyway", async () => {
    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    const onClose = vi.fn();
    render(
      <RoadPreviewPopover
        segment={segment()}
        onClose={onClose}
        onReroute={vi.fn()}
      />,
    );
    await screen.findByText("2.1");

    fireEvent.click(screen.getByRole("button", { name: /Close road preview/ }));
    fireEvent.click(screen.getByRole("button", { name: /Keep anyway/ }));
    fireEvent.click(screen.getByTestId("road-preview-popover"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("invokes onReroute with the segment, and hides the action when absent", async () => {
    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    const onReroute = vi.fn();
    const seg = segment();
    const { unmount } = render(
      <RoadPreviewPopover
        segment={seg}
        onClose={vi.fn()}
        onReroute={onReroute}
      />,
    );
    await screen.findByText("2.1");

    fireEvent.click(
      screen.getByRole("button", { name: /Reroute around this/ }),
    );
    expect(onReroute).toHaveBeenCalledWith(seg);
    unmount();

    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    render(<RoadPreviewPopover segment={segment()} onClose={vi.fn()} />);
    await screen.findByText("2.1");
    expect(
      screen.queryByRole("button", { name: /Reroute around this/ }),
    ).not.toBeInTheDocument();
    // Read-only surfaces hide the route decisions entirely — no Keep
    // anyway either, just the header close.
    expect(
      screen.queryByRole("button", { name: /Keep anyway/ }),
    ).not.toBeInTheDocument();
  });

  it("refetches when the segment changes", async () => {
    getRoadPreviewMock.mockResolvedValue(measuredPreview());
    const { rerender } = render(
      <RoadPreviewPopover segment={segment()} onClose={vi.fn()} />,
    );
    await screen.findByText("2.1");

    const other = segment({ id: "d1-s3" });
    getRoadPreviewMock.mockResolvedValue(
      measuredPreview({ segmentId: "d1-s3", score: 4.4, band: "good" }),
    );
    rerender(<RoadPreviewPopover segment={other} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(getRoadPreviewMock).toHaveBeenLastCalledWith(other),
    );
    expect(await screen.findByText("4.4")).toBeInTheDocument();
  });
});
