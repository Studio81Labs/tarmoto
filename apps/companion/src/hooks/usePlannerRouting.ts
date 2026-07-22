import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { routingApi, type RouteResponse } from "@/lib/api";
import {
  concatLegRouteResponses,
  type PlannerRoutingLeg,
  type TripLegBreak,
} from "@/lib/planner/leg-routing";

export function usePlannerRouting(
  // Route computation is per LEG (revision 3 §C): each consecutive
  // routing-waypoint pair is requested separately with its effective
  // road preference, then concatenated back into one RouteResponse.
  legs: readonly PlannerRoutingLeg[],
  // `onResult` receives the `requestKey` that was current when THIS request
  // fired, so a response that resolves after the caller switched context (e.g.
  // a different planner day) is applied to the day it was computed for — not
  // whatever is selected at resolution time.
  onResult: (
    r: RouteResponse,
    legBreaks: TripLegBreak[],
    requestKey: number | null,
  ) => void,
  onError: (message: string) => void,
  enabled = true,
  requestKey: number | null = null,
): { routing: boolean } {
  const [routing, setRouting] = useState(false);
  const reqIdRef = useRef(0);
  // Snapshot the latest callbacks so the effect doesn't re-run on identity churn.
  const cbRef = useRef({ onResult, onError });
  cbRef.current = { onResult, onError };

  useEffect(() => {
    // When disabled, do nothing — no debounce, no fetch, no routing state.
    if (!enabled) {
      setRouting(false);
      return;
    }
    if (legs.length === 0) {
      setRouting(false);
      return;
    }
    const controller = new AbortController();
    const reqId = ++reqIdRef.current;
    // Capture the key at request-fire time. The effect re-runs (and this is
    // recaptured) whenever the inputs change, so it always matches the
    // legs this request was built from.
    const firedRequestKey = requestKey;
    const handle = setTimeout(() => {
      setRouting(true);
      Promise.all(
        legs.map((leg) =>
          routingApi
            .route(
              {
                waypoints: [leg.from, leg.to],
                ...(leg.options !== undefined ? { options: leg.options } : {}),
              },
              { signal: controller.signal },
            )
            .then(({ data }) => data),
        ),
      )
        .then((responses) => {
          // Also bail when this request's controller was aborted (the prior
          // effect's cleanup aborts it when routing is disabled or the legs
          // vanish). The early-return paths don't advance reqIdRef, so
          // without this an already-resolved fetch could apply stale
          // geometry to the now-current trip.
          if (controller.signal.aborted || reqId !== reqIdRef.current) return;
          const { merged, legBreaks } = concatLegRouteResponses(
            legs,
            responses,
          );
          cbRef.current.onResult(merged, legBreaks, firedRequestKey);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || reqId !== reqIdRef.current) return;
          cbRef.current.onError(
            err instanceof Error
              ? err.message
              : t("Could not compute the route"),
          );
        })
        .finally(() => {
          if (reqId === reqIdRef.current) setRouting(false);
        });
    }, 300);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [legs, enabled, requestKey]);

  return { routing };
}
