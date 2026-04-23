import { render, screen } from "@testing-library/react";
import { SegmentTrendChart } from "./SegmentTrendChart";
import type { QualityPoint } from "@/lib/segment-trend";

const history: QualityPoint[] = [
  { date: "2026-01-10", score: 3.1 },
  { date: "2026-02-10", score: 3.8 },
  { date: "2026-03-10", score: 4.2 },
];

const regionalHistory: QualityPoint[] = [
  { date: "2026-01-10", score: 2.9 },
  { date: "2026-02-10", score: 3.3 },
  { date: "2026-03-10", score: 3.7 },
];

describe("SegmentTrendChart", () => {
  beforeAll(() => {
    class MockResizeObserver {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  it("renders the chart and legend when there is enough trend history", () => {
    render(
      <SegmentTrendChart
        segmentId="segment-1"
        history={history}
        regionalHistory={regionalHistory}
        now={new Date("2026-03-20T00:00:00.000Z")}
      />,
    );

    expect(
      screen.getByTestId("segment-trend-chart-segment-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("This segment")).toBeInTheDocument();
    expect(screen.getByText("Regional avg")).toBeInTheDocument();
  });

  it("shows the empty-state copy when there is only one distinct reading date", () => {
    render(
      <SegmentTrendChart
        segmentId="segment-2"
        history={[{ date: "2026-03-10", score: 4.2 }]}
        now={new Date("2026-03-20T00:00:00.000Z")}
      />,
    );

    expect(
      screen.getByText(
        "Not enough readings in this range to plot a trend yet.",
      ),
    ).toBeInTheDocument();
  });
});
