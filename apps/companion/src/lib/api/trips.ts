import type { paths } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonResponse, JsonRequest } from "./client";

// ── Trip endpoints (generated OpenAPI contract) ──
export type ListTripsQuery = NonNullable<
  paths["/api/v1/trips"]["get"]["parameters"]["query"]
>;
export type TripSummaryResponse = JsonResponse<"/api/v1/trips", "get", 200>;
export type TripDetailResponse = JsonResponse<
  "/api/v1/trips/{tripId}",
  "get",
  200
>;
export type CreateTripInput = JsonRequest<"/api/v1/trips", "post">;
export type ImportTripInput = JsonRequest<"/api/v1/trips/import", "post">;
export type UpdateTripInput = JsonRequest<"/api/v1/trips/{tripId}", "patch">;
export type GenerateTripInput = JsonRequest<
  "/api/v1/trips/{tripId}/generate",
  "post"
>;
export type GenerateTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/generate",
  "post",
  201
>;
export type DuplicateTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/duplicate",
  "post",
  201
>;
export type InviteTripResponse = JsonResponse<
  "/api/v1/trips/{tripId}/invite",
  "post",
  202
>;
export type SaveRouteBody = JsonRequest<"/api/v1/trips/{tripId}/route", "put">;
export type UpdateWaypointNamesBody = JsonRequest<
  "/api/v1/trips/{tripId}/waypoints",
  "patch"
>;
export type TripInvitePreview = JsonResponse<
  "/api/v1/trips/{tripId}/invite/{code}/preview",
  "get",
  200
>;

export const tripsApi = {
  list: (params?: ListTripsQuery) =>
    openApiData<TripSummaryResponse>(
      api.GET("/api/v1/trips", params ? { params: { query: params } } : {}),
    ),
  get: (id: string) =>
    openApiData<TripDetailResponse>(
      api.GET("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
      }),
    ),
  // Mutations below accept an optional `init` so a caller can abort a request
  // the moment its surface is torn down (the planner threads its
  // `trip_planning` kill-switch signal here, #1163). Same `reqSignal` seam as
  // the read helpers in `roads.ts` — only the abort signal is forwarded.
  create: (data: CreateTripInput, init?: RequestInit) =>
    openApiData<TripDetailResponse>(
      api.POST("/api/v1/trips", { body: data, ...reqSignal(init) }),
    ),
  importRoute: (data: ImportTripInput, init?: RequestInit) =>
    openApiData<TripDetailResponse>(
      api.POST("/api/v1/trips/import", { body: data, ...reqSignal(init) }),
    ),
  replaceImportedRoute: (
    id: string,
    data: ImportTripInput,
    init?: RequestInit,
  ) =>
    openApiData<TripDetailResponse>(
      api.PUT("/api/v1/trips/{tripId}/import", {
        params: { path: { tripId: id } },
        body: data,
        ...reqSignal(init),
      }),
    ),
  update: (id: string, data: UpdateTripInput, init?: RequestInit) =>
    openApiData<TripDetailResponse>(
      api.PATCH("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
        body: data,
        ...reqSignal(init),
      }),
    ),
  delete: (id: string, init?: RequestInit) =>
    openApiData<void>(
      api.DELETE("/api/v1/trips/{tripId}", {
        params: { path: { tripId: id } },
        ...reqSignal(init),
      }),
    ),
  // POST /trips/:tripId/generate (US-7) — backend builds three preset
  // options (best-fit / scenic / fastest), persists the selected one,
  // and returns all three for side-by-side comparison.
  generate: (tripId: string, params: GenerateTripInput) =>
    openApiData<GenerateTripResponse>(
      api.POST("/api/v1/trips/{tripId}/generate", {
        params: { path: { tripId } },
        body: params,
      }),
    ),
  duplicate: (tripId: string) =>
    openApiData<DuplicateTripResponse>(
      api.POST("/api/v1/trips/{tripId}/duplicate", {
        params: { path: { tripId } },
      }),
    ),
  // GET /trips/:tripId/invite/:code/preview — masked pre-accept preview
  // for an invited (not-yet-member) rider, authorized by the invite code.
  // 404s on an unknown/revoked code. Read-only: does not consume the invite.
  getInvitePreview: (tripId: string, code: string) =>
    openApiData<TripInvitePreview>(
      api.GET("/api/v1/trips/{tripId}/invite/{code}/preview", {
        params: { path: { tripId, code } },
      }),
    ),
  // POST /trips/:tripId/join — accept an invite by submitting the
  // trip id + invite code. Returns the trip detail on success and
  // 403s on a wrong code (folded with "no such trip" so the endpoint
  // can't be used to enumerate ids).
  join: (tripId: string, inviteCode: string) =>
    openApiData<TripDetailResponse>(
      api.POST("/api/v1/trips/{tripId}/join", {
        params: { path: { tripId } },
        body: { invite_code: inviteCode },
      }),
    ),
  // POST /trips/:tripId/invite — owner/admin only. Mail dispatch is
  // best-effort: the backend returns 202 + `{ status: "queued" }` once
  // the audit row lands, regardless of whether the email provider
  // accepted the message. The recipient does NOT need a Tarmoto
  // account; the email explains how to sign up and join.
  invite: (tripId: string, email: string, message?: string) =>
    openApiData<InviteTripResponse>(
      api.POST("/api/v1/trips/{tripId}/invite", {
        params: { path: { tripId } },
        body: message ? { email, message } : { email },
      }),
    ),
  // PUT /trips/:tripId/route — any trip member may submit waypoints;
  // the server re-routes via Valhalla, enriches via PostGIS, and
  // replaces day 1 atomically. Returns the full updated trip detail.
  saveRoute: (tripId: string, body: SaveRouteBody, init?: RequestInit) =>
    openApiData<TripDetailResponse>(
      api.PUT("/api/v1/trips/{tripId}/route", {
        params: { path: { tripId } },
        body,
        ...reqSignal(init),
      }),
    ),
  // PATCH /trips/:tripId/waypoints — rename waypoints (matched by id) WITHOUT
  // re-routing; persists late reverse-geocoded pin names on a loaded trip
  // without reshaping its route (#911).
  updateWaypointNames: (
    tripId: string,
    body: UpdateWaypointNamesBody,
    init?: RequestInit,
  ) =>
    openApiData<TripDetailResponse>(
      api.PATCH("/api/v1/trips/{tripId}/waypoints", {
        params: { path: { tripId } },
        body,
        ...reqSignal(init),
      }),
    ),
};
