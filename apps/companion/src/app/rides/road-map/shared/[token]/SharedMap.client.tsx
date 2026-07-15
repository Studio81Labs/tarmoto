"use client";

import { useMemo, useRef, useState } from "react";
import {
  PersonalRoadMap,
  type PersonalRoadMapHandle,
} from "@/app/(dashboard)/rides/road-map/_components/PersonalRoadMap";
import { RoadSegmentPopover } from "@/app/(dashboard)/rides/road-map/_components/RoadSegmentPopover";
import type { RiddenSegment } from "@/lib/road-map-layer";
import { usePreferencesStore } from "@/stores/preferences";

interface Props {
  initialCenter: { lat: number; lng: number; zoom: number };
  segments: readonly RiddenSegment[];
}

export function SharedMap({ initialCenter, segments }: Props) {
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  const unitSystem = usePreferencesStore((s) => s.unitSystem);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  );
  const selectedSegment = useMemo(
    () =>
      selectedSegmentId
        ? (segments.find((s) => s.id === selectedSegmentId) ?? null)
        : null,
    [selectedSegmentId, segments],
  );
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
        onSegmentSelect={setSelectedSegmentId}
      />
      {selectedSegment && (
        <RoadSegmentPopover
          segment={selectedSegment}
          unitSystem={unitSystem}
          onClose={() => setSelectedSegmentId(null)}
        />
      )}
    </div>
  );
}
