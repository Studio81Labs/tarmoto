import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonRequest } from "./client";

// ── Closures endpoints (US-40 seasonal closures & roadworks) ──

export type RoadClosure = components["schemas"]["RoadClosureDto"];
export type RoadClosureReason = RoadClosure["reason"];
export type RoadClosureSeverity = RoadClosure["severity"];
export type RoadClosurePoint = components["schemas"]["ClosurePointDto"];
export type CheckRouteClosuresResponse =
  components["schemas"]["CheckRouteClosuresResponseDto"];

// `buffer_m` is `@ApiPropertyOptional` (server default) in the backend, but
// openapi-typescript emits defaulted fields as required. Keep it optional at
// the boundary so callers can rely on the server default.
type CheckRouteClosuresInput = Omit<
  JsonRequest<"/api/v1/closures/check-route", "post">,
  "buffer_m"
> & { buffer_m?: number };

export const closuresApi = {
  list: (
    params: {
      bbox?: string;
      active_on?: string;
      severity?: RoadClosureSeverity;
      reason?: RoadClosureReason;
      include_past?: boolean;
    },
    init?: RequestInit,
  ) =>
    openApiData<RoadClosure[]>(
      api.GET("/api/v1/closures", {
        params: { query: params },
        ...reqSignal(init),
      }),
    ),
  checkRoute: (data: CheckRouteClosuresInput, init?: RequestInit) =>
    openApiData<CheckRouteClosuresResponse>(
      api.POST("/api/v1/closures/check-route", {
        // Cast bridges the spec's spurious `buffer_m: required` (see the input
        // type note) — omitting it at runtime lets the server apply its default.
        body: data as JsonRequest<"/api/v1/closures/check-route", "post">,
        ...reqSignal(init),
      }),
    ),
};
