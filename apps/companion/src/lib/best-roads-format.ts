import type { Formatters } from "@tarmoto/shared";
import type { BestRoad } from "@/lib/bestRoads";

type RoadLabelInput = Pick<BestRoad, "id" | "road_name" | "road_number">;

export function formatRoadLength(lengthM: number, format: Formatters): string {
  return format.distanceM(lengthM);
}

export function formatRoadQuality(
  qualityScore: number | null,
  format: Formatters,
): string {
  return qualityScore == null ? "—" : format.decimal(qualityScore, 1);
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
