"use client";

import { useMemo, useRef, useState } from "react";
import {
  PersonalRoadMap,
  type PersonalRoadMapHandle,
} from "@/app/(dashboard)/rides/road-map/_components/PersonalRoadMap";
import { RoadSegmentPopover } from "@/app/(dashboard)/rides/road-map/_components/RoadSegmentPopover";
import type { RiddenSegment } from "@/lib/road-map-layer";

interface Props {
  initialCenter: { lat: number; lng: number; zoom: number };
  segments: readonly RiddenSegment[];
}

export function SharedMap({ initialCenter, segments }: Props) {
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const segmentIds = useMemo(
    () => new Set(segments.map((s) => s.id)),
    [segments],
  );
  const selectedSegment = useMemo(
    () =>
      selectedSegmentId
        ? (segments.find((s) => s.id === selectedSegmentId) ?? null)
        : null,
    [selectedSegmentId, segments],
  );
  // The map now selects any road under the tap, but a shared map only knows its
  // snapshot segments. Ignore taps on roads outside it (keep the current
  // selection) so an unrelated road isn't highlighted with no popover; an empty
  // tap (null) still deselects.
  const handleSharedSelect = (id: string | null) => {
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
        // ride tracks), so show coverage and hide the routes view.
        showCoverage
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
