import type { MapPoint } from "@/components/map/MapPointPopover";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";

/** The condition a row tap flew the map to; `null` when nothing is pinned. */
export type PinnedCondition = { kind: "closure" | "pass"; id: string } | null;

/** Outcome for an open condition popover after the fetched lists change. */
export type ConditionReconcileAction =
  | { type: "keep" }
  | { type: "close" }
  | { type: "refresh"; point: Extract<MapPoint, { kind: "closure" | "pass" }> };

/**
 * Decide what happens to the open condition popover when the viewport
 * closures/passes lists update. Pure so the keep-vs-close policy can be unit
 * tested without the map. Rules:
 *
 * - While the backing list is still loading (pending → transiently `[]`), keep
 *   the card — a pan/fly refetch shouldn't drop it on the empty frame.
 * - If the condition is in the fresh list, refresh its DTO (e.g. a new seasonal
 *   status). The explorer markers every pass — including open — so an open pass
 *   is refreshed like any other, not closed.
 * - If it's absent, keep it only when it's the row we just flew to (`pinned`);
 *   the destination cache can predate it. Otherwise it's genuinely gone → close.
 *
 * A pinned-but-absent card is retired separately by {@link pinnedConditionRetired}
 * once a *completed* fetch confirms the absence.
 */
export function reconcileConditionMenu(
  point: MapPoint,
  o: {
    closures: readonly PlannerClosure[];
    passes: readonly MountainPass[];
    closuresLoading: boolean;
    passesLoading: boolean;
    pinned: PinnedCondition;
  },
): ConditionReconcileAction {
  if (point.kind === "closure") {
    if (o.closuresLoading) return { type: "keep" };
    const fresh = o.closures.find((c) => c.id === point.closure.id);
    if (fresh) {
      return {
        type: "refresh",
        point: { kind: "closure", closure: fresh, affectsRoute: false },
      };
    }
    return o.pinned?.kind === "closure" && o.pinned.id === point.closure.id
      ? { type: "keep" }
      : { type: "close" };
  }
  if (point.kind === "pass") {
    if (o.passesLoading) return { type: "keep" };
    const fresh = o.passes.find((p) => p.id === point.pass.id);
    if (fresh) {
      return {
        type: "refresh",
        point: { kind: "pass", pass: fresh, affectsRoute: false },
      };
    }
    return o.pinned?.kind === "pass" && o.pinned.id === point.pass.id
      ? { type: "keep" }
      : { type: "close" };
  }
  return { type: "keep" };
}

/**
 * Whether a pinned condition should be retired — pin released and popover
 * closed — because a *completed* fetch (its query's fetching flag just fell
 * true → false) settled without it. This is what stops the pin from holding a
 * card indefinitely when the row came from a stale list or the item was
 * deleted/expired. `*Settled` must be the falling edge, not merely "not
 * fetching", so the pre-refetch stale frame (idle + stale) can't trip it.
 */
export function pinnedConditionRetired(
  pin: NonNullable<PinnedCondition>,
  o: {
    closures: readonly PlannerClosure[];
    passes: readonly MountainPass[];
    closuresSettled: boolean;
    passesSettled: boolean;
  },
): boolean {
  if (pin.kind === "closure") {
    return o.closuresSettled && !o.closures.some((c) => c.id === pin.id);
  }
  return o.passesSettled && !o.passes.some((p) => p.id === pin.id);
}
