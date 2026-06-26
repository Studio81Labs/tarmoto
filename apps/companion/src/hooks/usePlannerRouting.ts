import { useEffect, useRef, useState } from "react";
import {
  routingApi,
  type RouteRequestBody,
  type RouteResponse,
} from "@/lib/api";

export function usePlannerRouting(
  waypoints: ReadonlyArray<{ lat: number; lng: number }>,
  options: RouteRequestBody["options"],
  onResult: (r: RouteResponse) => void,
  onError: (message: string) => void,
  enabled = true,
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
    if (waypoints.length < 2) {
      setRouting(false);
      return;
    }
    const controller = new AbortController();
    const reqId = ++reqIdRef.current;
    const handle = setTimeout(() => {
      setRouting(true);
      routingApi
        .route(
          { waypoints: [...waypoints], options },
          { signal: controller.signal },
        )
        .then(({ data }) => {
          if (reqId === reqIdRef.current) cbRef.current.onResult(data);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || reqId !== reqIdRef.current) return;
          cbRef.current.onError(
            err instanceof Error ? err.message : "Could not compute the route",
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
  }, [waypoints, options, enabled]);

  return { routing };
}
