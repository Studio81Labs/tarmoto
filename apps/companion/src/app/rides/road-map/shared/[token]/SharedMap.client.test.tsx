import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RiddenSegment } from "@/lib/road-map-layer";
import { SharedMap } from "./SharedMap.client";

// Kill switches fail SAFE (enabled until a confirmed `force_off`).
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

// The map itself is gated and tested elsewhere; this suite is about the parent
// that owns the selection and the popover. The stub exposes the select callback
// so a test can drive a selection without a MapLibre canvas.
const selectHandlers: Array<(id: string | null) => void> = [];
vi.mock("@/app/(dashboard)/rides/road-map/_components/PersonalRoadMap", () => ({
  PersonalRoadMap: ({
    onSegmentSelect,
    selectedSegmentId,
  }: {
    onSegmentSelect: (id: string | null) => void;
    selectedSegmentId: string | null;
  }) => {
    selectHandlers.push(onSegmentSelect);
    return <div data-testid="map" data-selected={selectedSegmentId ?? ""} />;
  },
}));

// Stubbed: this suite is about the PARENT's decision to render a popover at
// all. The real one fetches `getSegmentDetail` and needs format + i18n context,
// and its own rendering is not what the kill switch turns on.
vi.mock(
  "@/app/(dashboard)/rides/road-map/_components/RoadSegmentPopover",
  () => ({
    RoadSegmentPopover: ({ segment }: { segment: { id: string } }) => (
      <div data-testid="segment-popover">{segment.id}</div>
    ),
  }),
);

function segment(id: string): RiddenSegment {
  return {
    id,
    name: "Test Road",
    qualityScore: 4.2,
    geometry: {
      type: "LineString",
      coordinates: [
        [16.6, 49.2],
        [16.7, 49.3],
      ],
    },
  } as unknown as RiddenSegment;
}

function renderShared() {
  selectHandlers.length = 0;
  return render(
    <SharedMap
      initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
      segments={[segment("seg-1")]}
    />,
  );
}

describe("SharedMap (public share page)", () => {
  it("opens the segment popover on a selection", () => {
    killSwitch.enabled = true;
    renderShared();
    act(() => selectHandlers[0]?.("seg-1"));
    expect(screen.getByTestId("segment-popover")).toBeInTheDocument();
  });

  it("shows no popover, and refuses selection, while the overlay is killed", () => {
    // This page is reachable by ANYONE with the link — no account, no session.
    // The popover is where the segment's quality score is rendered, so leaving
    // it live would serve the killed data to anonymous visitors.
    killSwitch.enabled = false;
    renderShared();
    act(() => selectHandlers[0]?.("seg-1"));
    expect(screen.queryByTestId("segment-popover")).toBeNull();
    expect(screen.getByTestId("map")).toHaveAttribute("data-selected", "");
  });

  it("drops an OPEN popover on a live kill", () => {
    // Derived, not cleared in an effect, so there is no frame in which a
    // quality score sits over a map whose layers have already gone.
    killSwitch.enabled = true;
    const { rerender } = renderShared();
    act(() => selectHandlers[0]?.("seg-1"));
    expect(screen.getByTestId("segment-popover")).toBeInTheDocument();

    killSwitch.enabled = false;
    rerender(
      <SharedMap
        initialCenter={{ lat: 49.2, lng: 16.6, zoom: 10 }}
        segments={[segment("seg-1")]}
      />,
    );
    expect(screen.queryByTestId("segment-popover")).toBeNull();
  });
});
