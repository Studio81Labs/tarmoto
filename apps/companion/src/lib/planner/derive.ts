import { segmentizeRoute } from "./segmentize";
import type { RouteSegment } from "./types";

/**
 * The geometry-only quality baseline: turns routed geometry into display
 * segments carrying NO quality — every segment is `no_data`. Deterministic —
 * same geometry in, same segments out — so consumers can derive on demand
 * (map layers, panel strips) without caching or store state, and every
 * geometry source (live routing, GPX import, demo trips, saved trips) gets
 * the same treatment.
 *
 * Real per-segment quality comes from `POST /roads/route-quality`
 * (`plannerApi.getRouteQuality`, mapped in `./route-quality`) and is stored on
 * the day. This baseline is what renders before that resolves, and the
 * fallback when the route isn't covered or the query fails.
 */
export function deriveQualitySegments(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  dayNumber: number,
  // Present when the day was routed per leg (revision 3 §C): namespaces
  // segment ids per leg and tags every segment with its legId.
  leg?: { index: number; id: string },
): RouteSegment[] {
  const slices = segmentizeRoute(
    points,
    dayNumber,
    leg ? `d${dayNumber}-l${leg.index}` : undefined,
  );
  return slices.map((slice): RouteSegment => ({
    ...slice,
    band: "no_data",
    surface: "unknown",
    score: null,
    passes: 0,
    ...(leg ? { legId: leg.id } : {}),
  }));
}
