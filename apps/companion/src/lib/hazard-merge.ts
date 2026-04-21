import type { HazardResponse } from "@/lib/api";

/**
 * Merge a REST hazard snapshot with any WebSocket-delivered hazards that
 * arrived after the REST fetch started. The REST snapshot is taken
 * server-side at some point between `fetchStartedAt` and the response
 * landing — hazards emitted on the socket during that window aren't in
 * the snapshot, so we must preserve them or their markers would
 * disappear when the REST response overwrites local state.
 *
 * WS-origin hazards already present in the REST result are dropped from
 * `wsArrivalAt` so subsequent REST fetches don't re-preserve them.
 */
export function mergeHazardsWithInFlightWsArrivals(
  restResult: HazardResponse[],
  current: HazardResponse[],
  wsArrivalAt: Map<string, number>,
  fetchStartedAt: number,
): HazardResponse[] {
  const restIds = new Set(restResult.map((h) => h.id));
  const preserved = current.filter((h) => {
    const arrivedAt = wsArrivalAt.get(h.id);
    return (
      arrivedAt !== undefined &&
      arrivedAt >= fetchStartedAt &&
      !restIds.has(h.id)
    );
  });
  // Hazards the REST snapshot now covers no longer need preservation; drop
  // their arrival timestamps so the map doesn't leak entries for every
  // hazard ever seen.
  for (const id of restIds) wsArrivalAt.delete(id);
  return [...restResult, ...preserved];
}
