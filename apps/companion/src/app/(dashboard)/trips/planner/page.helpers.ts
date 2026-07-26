import type { Waypoint } from "@/lib/types";

interface DraftedVia {
  lat: number;
  lng: number;
  /** Present only for source-owned zone/place names. */
  name?: string;
}

type InsertWaypoint = (dayIndex: number, waypoint: Waypoint) => void;

/**
 * Cross the planner API → trip-store boundary without turning generated roles
 * into names. Real source names retain provenance even when they resemble a
 * legacy generated label such as "Via 1".
 */
export function insertDraftedVias(
  vias: readonly DraftedVia[],
  dayIndex: number,
  idPrefix: "draft" | "loop",
  insertWaypoint: InsertWaypoint,
  now = Date.now(),
): void {
  vias.forEach((via, index) => {
    insertWaypoint(dayIndex, {
      id: `${idPrefix}-${now}-${index}`,
      ...(via.name ? { name: via.name, nameIsSource: true } : {}),
      location: { lat: via.lat, lng: via.lng },
      type: "via",
    });
  });
}
