/**
 * One map-click router that dispatches a click to exactly ONE owning layer by
 * explicit z-order, replacing the pile of per-layer `map.on("click", LAYER)`
 * handlers plus manual "is a higher-priority marker also under the cursor?"
 * guards that accumulated across the map surfaces.
 *
 * MapLibre fires EVERY layer-specific click handler whose layer is under the
 * cursor (stacking order doesn't gate them), so overlapping markers used to
 * each need a `queryRenderedFeatures` guard against every layer above them.
 * Here a single `queryRenderedFeatures` over all interactive layers picks the
 * topmost hit — routes are listed topmost-first, so the first route with a hit
 * owns the click and nothing else fires. A click that hits no interactive
 * layer falls through to `onMiss` (dismiss popovers / select the road / open
 * the context menu). No swallow-ref dance: at most one handler runs per click.
 */

import type {
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapMouseEvent,
} from "maplibre-gl";

export interface PointClickRoute {
  /**
   * Layer ids this route owns. Missing layers (not yet added, or from a map
   * surface that doesn't use them) are skipped, so the same route table can be
   * shared across maps that only register a subset.
   */
  layers: readonly string[];
  /** Invoked with the topmost hit feature belonging to one of `layers`. */
  handle: (feature: MapGeoJSONFeature, event: MapMouseEvent) => void;
}

export interface PointClickRouterOptions {
  /** Routes in TOPMOST-FIRST priority order — the first with a hit wins. */
  routes: readonly PointClickRoute[];
  /** Fired when the click hit none of the interactive layers. */
  onMiss?: (event: MapMouseEvent) => void;
  /** When it returns true the whole click is ignored (e.g. region drawing). */
  isBlocked?: () => boolean;
}

/**
 * Resolve which route (if any) owns a click at `event.point`, honouring the
 * topmost-first `routes` order. Exported for unit testing without a real map.
 */
export function resolvePointClick(
  map: MapLibreMap,
  event: MapMouseEvent,
  routes: readonly PointClickRoute[],
): { route: PointClickRoute; feature: MapGeoJSONFeature } | null {
  const present = routes
    .flatMap((route) => route.layers)
    .filter((id) => map.getLayer(id));
  if (present.length === 0) return null;
  const hits = map.queryRenderedFeatures(event.point, { layers: present });
  if (hits.length === 0) return null;
  // Pick by explicit route order rather than trusting the query's result
  // ordering: the first route (topmost) with any hit under the cursor owns it.
  for (const route of routes) {
    const feature = hits.find((hit) => route.layers.includes(hit.layer.id));
    if (feature) return { route, feature };
  }
  return null;
}

/**
 * Register the single click handler. Returns a teardown that removes it.
 */
export function installPointClickRouter(
  map: MapLibreMap,
  { routes, onMiss, isBlocked }: PointClickRouterOptions,
): () => void {
  const onClick = (event: MapMouseEvent) => {
    if (isBlocked?.()) return;
    const resolved = resolvePointClick(map, event, routes);
    if (resolved) {
      resolved.route.handle(resolved.feature, event);
      return;
    }
    onMiss?.(event);
  };
  map.on("click", onClick);
  return () => {
    map.off("click", onClick);
  };
}
