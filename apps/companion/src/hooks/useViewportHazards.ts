import { useEffect, type RefObject } from "react";
import { hazardsApi } from "@/lib/api";
import {
  HAZARD_FETCH_DEBOUNCE_MS,
  HAZARD_MIN_ZOOM,
  setHazardSourceData,
  viewportRadiusMeters,
} from "@/components/map/HazardPinLayer";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";

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
  // Operator kill switch, applied INSIDE the hook so every caller is covered by
  // one gate rather than each map remembering to pass it. Fails safe: hazards
  // stay visible until a `force_off` is confirmed.
  //
  // The teardown below is what makes this a real kill switch rather than a
  // mount-time check — flipping the switch on a live session clears the source
  // on the next effect run instead of leaving stale pins on the map.
  const { enabled: killSwitchOn } = useFeatureKillSwitch("hazard_alerts");
  const active = enabled && killSwitchOn;

  useEffect(() => {
    const map = mapRef.current?.map;
    // jsdom's map mock has no getBounds — the layer simply stays empty.
    if (!map || typeof map.getBounds !== "function") return;
    if (!active || (map.getZoom?.() ?? 0) < HAZARD_MIN_ZOOM) {
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
    // `active`, not `enabled` — a kill-switch flip on a live session has to
    // re-run this effect to clear the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, viewportToken]);
}
