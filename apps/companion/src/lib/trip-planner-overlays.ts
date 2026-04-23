import type { FeatureCollection, LineString, Point } from "geojson";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";

export interface PlannerClosureFeatureProps {
  id: string;
  title: string;
  severity: PlannerClosure["severity"];
  reason: PlannerClosure["reason"];
}

export interface PlannerPassFeatureProps {
  id: string;
  name: string;
  status: MountainPass["status"];
  elevationM: number;
}

export function buildPlannerClosureLineCollection(
  closures: readonly PlannerClosure[],
): FeatureCollection<LineString, PlannerClosureFeatureProps> {
  return {
    type: "FeatureCollection",
    features: closures.flatMap((closure) =>
      closure.geometry.length >= 2
        ? [
            {
              type: "Feature" as const,
              geometry: {
                type: "LineString" as const,
                coordinates: closure.geometry.map((point) => [
                  point.lng,
                  point.lat,
                ]),
              },
              properties: {
                id: closure.id,
                title: closure.title,
                severity: closure.severity,
                reason: closure.reason,
              },
            },
          ]
        : [],
    ),
  };
}

export function buildPlannerClosureMarkerCollection(
  closures: readonly PlannerClosure[],
): FeatureCollection<Point, PlannerClosureFeatureProps> {
  return {
    type: "FeatureCollection",
    features: closures.flatMap((closure) => {
      const marker = closure.geometry[0];
      if (!marker) return [];

      return [
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [marker.lng, marker.lat],
          },
          properties: {
            id: closure.id,
            title: closure.title,
            severity: closure.severity,
            reason: closure.reason,
          },
        },
      ];
    }),
  };
}

export function buildPlannerPassMarkerCollection(
  passes: readonly MountainPass[],
): FeatureCollection<Point, PlannerPassFeatureProps> {
  return {
    type: "FeatureCollection",
    features: passes.map((pass) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [pass.lng, pass.lat],
      },
      properties: {
        id: pass.id,
        name: pass.name,
        status: pass.status,
        elevationM: pass.elevation_m,
      },
    })),
  };
}
