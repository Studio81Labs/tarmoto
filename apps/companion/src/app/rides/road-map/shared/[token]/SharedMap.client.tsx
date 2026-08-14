"use client";

import { useMemo, useRef, useState } from "react";
import {
  PersonalRoadMap,
  type PersonalRoadMapHandle,
} from "@/app/(dashboard)/rides/road-map/_components/PersonalRoadMap";
import { RoadSegmentPopover } from "@/app/(dashboard)/rides/road-map/_components/RoadSegmentPopover";
import type { SanitizedRiddenSegment } from "@/lib/road-map-layer";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

interface Props {
  initialCenter: { lat: number; lng: number; zoom: number };
  /** Sanitized when the overlay is killed: `last_quality_score` is REMOVED
   *  server-side, so the type only promises the fields that always survive. */
  segments: readonly SanitizedRiddenSegment[];
  /** The server already CONFIRMED `road_quality_overlay` is killed — see the
   *  hook below, which fails safe and cannot answer this on the first render. */
  qualityOverlayKilled?: boolean;
}

export function SharedMap({
  initialCenter,
  segments,
  qualityOverlayKilled = false,
}: Props) {
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  // `PersonalRoadMap` gates its own layers, but this parent owns the selection
  // and the popover, and the popover is where the segment's quality SCORE is
  // shown — the killed data itself, not a rendering of it. A public share page
  // reaches anonymous visitors, so this is the one gated surface with no
  // account behind it.
  const { enabled: clientCoverageEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );
  // EITHER source confirming a kill wins. The server's answer resolved before
  // this page was sent; the hook still covers a flip made after render, and a
  // SERVER flags request that failed and fell back to enabled.
  const coverageEnabled = !qualityOverlayKilled && clientCoverageEnabled;
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const segmentIds = useMemo(
    () => new Set(segments.map((s) => s.id)),
    [segments],
  );
  // Derived rather than cleared in an effect: a live flip drops the popover on
  // the same render that hides the layers, with no frame in between showing a
  // quality score over a blank map.
  const selectedSegment = useMemo(
    () =>
      selectedSegmentId && coverageEnabled
        ? (segments.find((s) => s.id === selectedSegmentId) ?? null)
        : null,
    [selectedSegmentId, segments, coverageEnabled],
  );
  // The map now selects any road under the tap, but a shared map only knows its
  // snapshot segments. Ignore taps on roads outside it (keep the current
  // selection) so an unrelated road isn't highlighted with no popover; an empty
  // tap (null) still deselects.
  const handleSharedSelect = (id: string | null) => {
    if (id !== null && !coverageEnabled) return;
    if (id !== null && !segmentIds.has(id)) return;
    setSelectedSegmentId(id);
  };
  return (
    <div className="absolute inset-0">
      <PersonalRoadMap
        ref={mapRef}
        initialCenter={initialCenter}
        ridden={segments}
        // A shared map is a coverage snapshot (ridden segments only, no live
        // ride tracks), so show coverage and hide the routes view — but pass
        // the EFFECTIVE decision, not a bare `true`. `PersonalRoadMap` builds
        // its own coverage layer and gates it on its own fail-safe hook, which
        // reports enabled until its browser request settles and stays that way
        // if it fails; without this, a server-confirmed kill still paints the
        // quality geometry and serves segment detail on a public page.
        showCoverage={coverageEnabled}
        showRoutes={false}
        selectedSegmentId={selectedSegmentId}
        // The public share page is always cream — pin the basemap to light and
        // paint unridden roads in a light tan that reads against it.
        forceColorScheme="light"
        dimColor="#C4BBA8"
        onSegmentSelect={handleSharedSelect}
      />
      {selectedSegment && (
        <RoadSegmentPopover
          segment={selectedSegment}
          onClose={() => setSelectedSegmentId(null)}
        />
      )}
    </div>
  );
}
