import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonRequest } from "./client";

// ── Mountain passes endpoints (US-40 seasonal closures & pass status) ──

export type CheckRoutePassesResponse =
  components["schemas"]["CheckRouteResponseDto"];

// `buffer_m` is `@ApiPropertyOptional` (server default) in the backend, but
// openapi-typescript emits defaulted fields as required. Keep it optional at
// the boundary so callers can rely on the server default.
type CheckRoutePassesInput = Omit<
  JsonRequest<"/api/v1/passes/check-route", "post">,
  "buffer_m"
> & { buffer_m?: number };

export const passesApi = {
  checkRoute: (data: CheckRoutePassesInput, init?: RequestInit) =>
    openApiData<CheckRoutePassesResponse>(
      api.POST("/api/v1/passes/check-route", {
        // Cast bridges the spec's spurious `buffer_m: required` (see the input
        // type note) — omitting it at runtime lets the server apply its default.
        body: data as JsonRequest<"/api/v1/passes/check-route", "post">,
        ...reqSignal(init),
      }),
    ),
};
