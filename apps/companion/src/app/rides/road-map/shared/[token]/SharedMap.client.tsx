"use client";

import { useRef } from "react";
import {
  PersonalRoadMap,
  type PersonalRoadMapHandle,
} from "@/app/(dashboard)/rides/road-map/_components/PersonalRoadMap";
import type { RiddenSegment } from "@/lib/road-map-layer";

interface Props {
  initialCenter: { lat: number; lng: number; zoom: number };
  segments: readonly RiddenSegment[];
}

export function SharedMap({ initialCenter, segments }: Props) {
  const mapRef = useRef<PersonalRoadMapHandle>(null);
  return (
    <div className="absolute inset-0">
      <PersonalRoadMap
        ref={mapRef}
        initialCenter={initialCenter}
        ridden={segments}
        // The public share page is always cream — pin the basemap to light and
        // paint unridden roads in a light tan that reads against it.
        forceColorScheme="light"
        dimColor="#C4BBA8"
      />
    </div>
  );
}
