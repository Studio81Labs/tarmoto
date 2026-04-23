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

export function formatRoadQualityColor(qualityScore: number | null): string {
  if (qualityScore == null) return "#64748B";
  if (qualityScore >= 4.5) return "#22C55E";
  if (qualityScore >= 3.5) return "#84CC16";
  if (qualityScore >= 2.5) return "#EAB308";
  if (qualityScore >= 1.5) return "#F97316";
  return "#EF4444";
}

export function formatRoadLabel(road: RoadLabelInput): string {
  return (
    road.road_name ??
    (road.road_number
      ? `Road ${road.road_number}`
      : `Segment ${road.id.slice(0, 6)}`)
  );
}
