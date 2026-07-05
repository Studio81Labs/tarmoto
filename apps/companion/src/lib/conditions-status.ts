/**
 * Data-state-aware status for CONDITIONS sections (revision 6): "no
 * data" must never read as "all clear". The green all-clear is EARNED
 * only when the source actually has data and none of it intersects the
 * route — an empty source is honestly UNKNOWN, mirroring the pass
 * legend's Closed / Unknown / Open vocabulary.
 */
export type ConditionStatus = "no_data" | "clear" | "warnings";

export function deriveConditionStatus(args: {
  /**
   * Items the source knows about for this region/period — the
   * availability signal. Zero here means "we have nothing to check
   * against", NOT "nothing is wrong".
   */
  sourceCount: number;
  /** Items actually intersecting the route. */
  routeHitCount: number;
}): ConditionStatus {
  // Route hits are proof of data by themselves — they win even when the
  // regional list happens to be empty (e.g. a hit just outside the bbox).
  if (args.routeHitCount > 0) return "warnings";
  if (args.sourceCount === 0) return "no_data";
  return "clear";
}
