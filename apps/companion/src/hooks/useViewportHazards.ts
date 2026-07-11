import { useEffect, type RefObject } from "react";
import { hazardsApi } from "@/lib/api";
import {
  HAZARD_FETCH_DEBOUNCE_MS,
  HAZARD_MIN_ZOOM,
  setHazardSourceData,
  viewportRadiusMeters,
} from "@/components/map/HazardPinLayer";

/**
 * Fetch hazards for the current viewport (debounced, zoom-gated) and drive the
 * hazard source added by `ensureHazardLayers`. A REST-only view of the road
 * explorer's richer hazard feed (no live websocket) for maps that just need
 * ambient hazard awareness. Re-runs whenever `viewportToken` changes (bump it
 * on `moveend`) or the layer is enabled/disabled.
 */
export function useViewportHazards(
  mapRef: RefObject<{ map: import("maplibre-gl").Map | null } | null>,
  { enabled, viewportToken }: { enabled: boolean; viewportToken: number },
): void {
  useEffect(() => {
    const map = mapRef.current?.map;
    // jsdom's map mock has no getBounds — the layer simply stays empty.
    if (!map || typeof map.getBounds !== "function") return;
    if (!enabled || (map.getZoom?.() ?? 0) < HAZARD_MIN_ZOOM) {
      setHazardSourceData(map, [], Date.now());
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const center = map.getCenter();
      hazardsApi
        .findNearby(
          {
            lat: center.lat,
            lng: center.lng,
            radius: viewportRadiusMeters(map),
          },
          { signal: controller.signal },
        )
        .then(({ data }) => {
          if (!cancelled) setHazardSourceData(map, data, Date.now());
        })
        .catch((err: unknown) => {
          // Superseded viewport aborts are expected; keep the current pins.
          if (cancelled || (err as { name?: string }).name === "AbortError") {
            return;
          }
          console.error("Failed to load hazards for the viewport", err);
        });
    }, HAZARD_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewportToken]);
}
