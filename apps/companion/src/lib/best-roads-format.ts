interface RoadLabelInput {
  id: string;
  road_name: string | null;
  road_number: string | null;
}

export function formatRoadLength(lengthM: number): string {
  return lengthM >= 1000
    ? `${(lengthM / 1000).toFixed(1)} km`
    : `${Math.round(lengthM)} m`;
}

export function formatRoadQuality(qualityScore: number | null): string {
  return qualityScore == null ? "—" : qualityScore.toFixed(1);
}

export function formatRoadLabel(road: RoadLabelInput): string {
  return (
    road.road_name ??
    (road.road_number
      ? `Road ${road.road_number}`
      : `Segment ${road.id.slice(0, 6)}`)
  );
}
