import { render, screen } from "@testing-library/react";
import { RoadPreviewCard } from "./RoadPreviewCard";
import type { RoutePreviewSegment } from "@/lib/types";

vi.mock("./RoadReviewsPanel", () => ({
  RoadReviewsPanel: ({ segmentId }: { segmentId: string }) => (
    <div>Reviews panel for {segmentId}</div>
  ),
}));

function segment(
  overrides: Partial<RoutePreviewSegment> = {},
): RoutePreviewSegment {
  return {
    id: "segment-1",
    name: "Alpine Pass",
    dayNumber: 1,
    orderInDay: 0,
    distanceKm: 24.2,
    qualityScore: 4.4,
    qualityTier: "good",
    surfaceType: "asphalt",
    curvinessScore: 72,
    elevationProfile: [620, 700, 760, 810],
    photos: [],
    activeHazards: [],
    ...overrides,
  };
}

describe("RoadPreviewCard", () => {
  it("renders the road reviews panel inside expanded details", () => {
    render(
      <RoadPreviewCard
        segment={segment()}
        isFocused={false}
        isHovered={false}
        isExpanded
        onFocus={() => {}}
        onHoverStart={() => {}}
        onHoverEnd={() => {}}
        onToggleExpand={() => {}}
      />,
    );

    expect(screen.getByText("Reviews panel for segment-1")).toBeInTheDocument();
  });

  it("preserves severity colour on the complete hazard message", () => {
    render(
      <RoadPreviewCard
        segment={segment({
          activeHazards: [
            {
              id: "hazard-1",
              type: "pothole",
              location: { type: "Point", coordinates: [14.4, 50.1] },
              reporterId: "rider-1",
              reporterName: "Ada",
              severity: "high",
              confirmations: 2,
              createdAt: "2026-07-25T08:00:00.000Z",
              expiresAt: "2026-07-26T08:00:00.000Z",
            },
          ],
        })}
        isFocused={false}
        isHovered={false}
        isExpanded
        onFocus={() => {}}
        onHoverStart={() => {}}
        onHoverEnd={() => {}}
        onToggleExpand={() => {}}
      />,
    );

    expect(screen.getByText("Pothole High")).toHaveClass("text-red-500");
  });
});
