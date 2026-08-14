/**
 * Ordering of road-detail refreshes (#1209).
 *
 * A `sys_poi_ratings` flip asks this screen for a fresh aggregate, so flipping
 * twice in quick succession leaves two `getRoadSegment` calls in flight. The
 * paused response carries a neutralised `avg_review_rating` and no embedded
 * reviews, so landing it last would leave the screen looking paused after
 * ratings had resumed.
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react-native";

jest.mock("@/components/Icon", () => {
  const ReactLib = require("react");
  const { Text } = require("react-native");
  return {
    Icon: ({ name }: { name?: string }) =>
      ReactLib.createElement(Text, null, `icon:${name ?? ""}`),
  };
});

jest.mock("react-native-svg", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  const Stub = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return { __esModule: true, default: Stub, Path: Stub };
});

const mockGetRoadSegment = jest.fn();
jest.mock("@/services/api", () => ({
  api: {
    getRoadSegment: (...a: unknown[]) => mockGetRoadSegment(...a),
    getReviews: jest.fn(async () => []),
    flushPendingReviews: jest.fn(async () => ({ flushed: 0 })),
  },
}));

const mockRouteParams = { segmentId: "seg-1" };
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: { segmentId: mockRouteParams.segmentId } }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

// Mutable so the test can drive the transitions that trigger the refreshes.
const mockRatings = { enabled: true };
jest.mock("@/hooks/useSystemSwitch", () => ({
  useSystemSwitchEnabled: () => mockRatings.enabled,
}));

import RoadPreviewScreen from "../RoadPreviewScreen";

function segment(name: string) {
  return {
    id: "seg-1",
    road_name: name,
    surface_type: "asphalt",
    quality_score: 4,
    quality_breakdown: {
      excellent: 1,
      good: 0,
      fair: 0,
      poor: 0,
      very_poor: 0,
    },
    review_count: 0,
    avg_review_rating: null,
    recent_reviews: [],
    active_hazards: [],
    hazard_count: 0,
  };
}

describe("RoadPreviewScreen — detail refresh ordering", () => {
  beforeEach(() => {
    mockRatings.enabled = true;
    mockRouteParams.segmentId = "seg-1";
    mockGetRoadSegment.mockReset();
  });

  it("discards a detail refresh that a newer one has superseded", async () => {
    let resolvePaused: ((v: unknown) => void) | undefined;
    let resolveResumed: ((v: unknown) => void) | undefined;
    mockGetRoadSegment
      .mockResolvedValueOnce(segment("Initial road"))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePaused = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveResumed = resolve;
        }),
      );

    const { rerender } = await render(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Initial road")).toBeTruthy();

    // Flip off: the transition asks for a fresh aggregate. That request hangs.
    mockRatings.enabled = false;
    await rerender(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(2));

    // Flip back on before it settles: a second refresh starts.
    mockRatings.enabled = true;
    await rerender(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(3));

    // The NEWER (resumed) response lands first...
    await act(async () => {
      resolveResumed?.(segment("Resumed road"));
    });
    expect(await screen.findByText("Resumed road")).toBeTruthy();

    // ...and the older paused one lands after. It must be discarded, or the
    // screen reverts to the paused aggregate after ratings have resumed.
    await act(async () => {
      resolvePaused?.(segment("Paused road"));
    });

    expect(screen.getByText("Resumed road")).toBeTruthy();
    expect(screen.queryByText("Paused road")).toBeNull();
  });

  it("discards a refresh for a road the screen has already left", async () => {
    // The generation advances only inside `refresh`, so a pending refresh for
    // road A survived a navigation to B and replaced B's details with A's.
    let resolveA: ((v: unknown) => void) | undefined;
    mockGetRoadSegment
      .mockResolvedValueOnce(segment("Road A"))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockResolvedValueOnce(segment("Road B"));

    const { rerender } = await render(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Road A")).toBeTruthy();

    // A ratings flip starts a refresh for A; it hangs.
    mockRatings.enabled = false;
    await rerender(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(2));

    // The rider navigates to B, which loads.
    mockRouteParams.segmentId = "seg-2";
    await rerender(<RoadPreviewScreen />);
    await waitFor(() => expect(mockGetRoadSegment).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Road B")).toBeTruthy();

    // A's refresh finally lands. It must not write over B.
    await act(async () => {
      resolveA?.(segment("Road A"));
    });

    expect(screen.getByText("Road B")).toBeTruthy();
    expect(screen.queryByText("Road A")).toBeNull();
  });
});
