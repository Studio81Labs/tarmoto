import { useEffect, useRef } from "react";
import { useFeatureKillSwitch } from "@/hooks/useEntitlements";
import { plannerApi } from "@/lib/planner/api";
import type { RouteSegment } from "@/lib/planner/types";
import type { Trip, TripDay } from "@/lib/types";

type ApplyRouteQuality = (
  dayNumber: number,
  forGeometry: ReadonlyArray<{ lat: number; lng: number }>,
  segments: RouteSegment[],
) => void;

/**
 * Hydrate real per-segment surface quality (#862) for every routed day of
 * `trip`. Used by BOTH the planner and the read-only saved-trip detail view, so
 * a saved trip with coverage shows real quality rather than the no_data
 * baseline.
 *
 * Fetches once per routed day that lacks quality (`POST /roads/route-quality`,
 * mapped client-side); `applyRouteQuality` stores the result guarded by the
 * geometry it was computed for. Per-day AbortControllers keep the work bounded:
 * a superseding request for a day aborts the prior one; a day that loses its
 * routable geometry (finish removed, route/day cleared) has its in-flight
 * lookup aborted; and unmount aborts all — so a long route's length-limit chunk
 * queries never keep running for a line the UI can no longer apply.
 */
export function useRouteQualityHydration(
  trip: Trip | null,
  applyRouteQuality: ApplyRouteQuality,
): void {
  const inFlightRef = useRef(
    new Map<number, NonNullable<TripDay["routeGeometry"]>>(),
  );
  const abortRef = useRef(new Map<number, AbortController>());
  // Gated in the hook rather than at its two call sites (the planner and the
  // read-only saved-trip detail) so neither can be missed, and so a third
  // consumer inherits the gate. A kill takes the same path as "no trip": every
  // in-flight per-day lookup is aborted and the bookkeeping cleared, so nothing
  // lands after the switch flips and nothing new is requested.
  const { enabled: qualityOverlayEnabled } = useFeatureKillSwitch(
    "road_quality_overlay",
  );

  useEffect(() => {
    const abort = abortRef.current;
    const inFlight = inFlightRef.current;
    if (!trip || !qualityOverlayEnabled) {
      for (const controller of abort.values()) controller.abort();
      abort.clear();
      inFlight.clear();
      return;
    }
    const routable = new Set<number>();
    for (const day of trip.days) {
      const geometry = day.routeGeometry;
      const coordinates = geometry?.coordinates;
      if (!geometry || !coordinates || coordinates.length < 2) continue;
      routable.add(day.dayNumber);
      if (day.qualitySegments) continue;
      if (inFlight.get(day.dayNumber) === geometry) continue;
      const points: { lat: number; lng: number }[] = [];
      for (const coordinate of coordinates) {
        const [lng, lat] = coordinate;
        if (typeof lng === "number" && typeof lat === "number") {
          points.push({ lat, lng });
        }
      }
      if (points.length < 2) continue;
      const dayNumber = day.dayNumber;
      // Abort a superseded in-flight request for this day (a reroute before the
      // previous resolved) so its remaining chunk queries don't keep running.
      abort.get(dayNumber)?.abort();
      const controller = new AbortController();
      abort.set(dayNumber, controller);
      inFlight.set(dayNumber, geometry);
      const settle = () => {
        if (inFlight.get(dayNumber) === geometry) inFlight.delete(dayNumber);
        if (abort.get(dayNumber) === controller) abort.delete(dayNumber);
      };
      void plannerApi
        .getRouteQuality(points, dayNumber, { signal: controller.signal })
        .then((segments) => applyRouteQuality(dayNumber, points, segments))
        .catch(() => {
          // Aborted, uncovered, or failed — stay on the no_data baseline.
        })
        .finally(settle);
    }
    // A day that lost its routable geometry (finish removed, route cleared, day
    // deleted) isn't visited above; abort its in-flight lookup so the chunk
    // queries stop instead of running for a line the UI can't apply.
    for (const [dayNumber, controller] of abort) {
      if (!routable.has(dayNumber)) {
        controller.abort();
        abort.delete(dayNumber);
        inFlight.delete(dayNumber);
      }
    }
  }, [trip, applyRouteQuality, qualityOverlayEnabled]);

  // Abort any in-flight quality fetches on unmount.
  useEffect(() => {
    const abort = abortRef.current;
    return () => {
      for (const controller of abort.values()) controller.abort();
      abort.clear();
    };
  }, []);
}
