import type { HazardResponse } from "@/lib/api";
import type { HazardNewEvent } from "@/lib/socket";

/**
 * Apply a single WebSocket `hazard:new` event to the current local list.
 *
 * A `severity === 'dismissed'` event is a moderation removal signal:
 *   - If the hazard is not in the list, return `{ action: 'tombstone', dismissedId }` —
 *     caller should record the tombstone so stale in-flight REST responses can be
 *     filtered before they resurrect the moderated marker.
 *   - Otherwise return `{ action: 'remove', list, dismissedId }` — caller should also
 *     clean the WS arrival timestamp entry for this id and record the tombstone.
 *
 * A normal (non-dismissed) event deduplicates and appends:
 *   - If already in the list, return `{ action: 'ignore' }`.
 *   - Otherwise return `{ action: 'append', list }` — caller should record
 *     the WS arrival timestamp.
 */
export type HazardWsAction =
  | { action: "ignore" }
  | { action: "append"; list: HazardResponse[] }
  | { action: "remove"; list: HazardResponse[]; dismissedId: string }
  | { action: "tombstone"; dismissedId: string };

export function applyHazardWsEvent(
  existing: HazardResponse[],
  hazard: HazardNewEvent,
): HazardWsAction {
  if (hazard.severity === "dismissed") {
    if (!existing.some((h) => h.id === hazard.id)) {
      return { action: "tombstone", dismissedId: hazard.id };
    }
    return {
      action: "remove",
      list: existing.filter((h) => h.id !== hazard.id),
      dismissedId: hazard.id,
    };
  }
  if (existing.some((h) => h.id === hazard.id)) return { action: "ignore" };
  return { action: "append", list: [...existing, hazard] };
}

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
 *
 * `dismissedAt` maps hazard id → ms timestamp when the dismissal was first
 * observed locally. Any hazard present in the REST result whose entry in
 * `dismissedAt` is >= `fetchStartedAt` is silently dropped — the REST
 * snapshot was taken before the admin dismissed it, so including it would
 * resurrect a moderated marker. Tombstone entries whose timestamp is
 * < `fetchStartedAt` are pruned: the fetch started after the dismissal,
 * so the server already excluded the hazard and the entry is spent.
 *
 * Do NOT call Date.now() inside this function — use `fetchStartedAt` as
 * the only time reference so the function stays pure and testable.
 */
export function mergeHazardsWithInFlightWsArrivals(
  restResult: HazardResponse[],
  current: HazardResponse[],
  wsArrivalAt: Map<string, number>,
  fetchStartedAt: number,
  dismissedAt: Map<string, number>,
): HazardResponse[] {
  // Drop hazards from the REST result that were dismissed after the fetch
  // started — the snapshot predates the admin action, so the data is stale.
  const filteredRest = restResult.filter((h) => {
    const t = dismissedAt.get(h.id);
    return t === undefined || t < fetchStartedAt;
  });

  // Prune spent tombstones: dismissal occurred before this fetch started, so
  // the server already excluded the hazard from the snapshot.
  for (const [id, t] of dismissedAt) {
    if (t < fetchStartedAt) dismissedAt.delete(id);
  }

  const restIds = new Set(filteredRest.map((h) => h.id));
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
  return [...filteredRest, ...preserved];
}
