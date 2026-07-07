import type { components } from "@tarmoto/openapi-client";
import { api, openApiData, reqSignal } from "./client";
import type { JsonRequest } from "./client";

// ── POI endpoints (US-36 / US-48 planner stops & stays) ──

export type AccommodationsResponse =
  components["schemas"]["AccommodationListDto"];
export type AccommodationSuggestion =
  AccommodationsResponse["accommodations"][number];
export type AccommodationKind = AccommodationSuggestion["kind"];

export type AlongRoutePoisResponse =
  components["schemas"]["AlongRoutePoiListDto"];
export type RoutePoiSuggestion = AlongRoutePoisResponse["pois"][number];
export type PoiKind = RoutePoiSuggestion["kind"];

export type StoredPoisResponse = components["schemas"]["StoredPoiListDto"];
export type StoredPoiSuggestion = StoredPoisResponse["pois"][number];

export type StoredCorridorResponse =
  components["schemas"]["StoredCorridorListDto"];
export type StoredCorridorPoiSuggestion =
  StoredCorridorResponse["pois"][number];

// `buffer_km` is `@ApiPropertyOptional` (server default) on the along-route and
// corridor bodies, but openapi-typescript emits defaulted fields as required.
// Keep it optional at the boundary so callers can rely on the server default.
type AlongRouteInput = Omit<
  JsonRequest<"/api/v1/poi/along-route", "post">,
  "buffer_km"
> & { buffer_km?: number };
type CorridorInput = Omit<
  JsonRequest<"/api/v1/poi/in-corridor", "post">,
  "buffer_km"
> & { buffer_km?: number };

export const poiApi = {
  getAccommodations: (
    params: {
      lat: number;
      lng: number;
      radius_km?: number;
      min_stars?: number;
      kinds?: AccommodationKind[];
    },
    init?: RequestInit,
  ) =>
    openApiData<AccommodationsResponse>(
      api.GET("/api/v1/poi/accommodations", {
        params: { query: params },
        ...reqSignal(init),
      }),
    ),
  getAlongRoute: (data: AlongRouteInput, init?: RequestInit) =>
    openApiData<AlongRoutePoisResponse>(
      api.POST("/api/v1/poi/along-route", {
        body: data as JsonRequest<"/api/v1/poi/along-route", "post">,
        ...reqSignal(init),
      }),
    ),
  getInBbox: (
    params: {
      minLng: number;
      minLat: number;
      maxLng: number;
      maxLat: number;
      kinds?: string[];
      limit?: number;
    },
    init?: RequestInit,
  ) =>
    openApiData<StoredPoisResponse>(
      api.GET("/api/v1/poi/in-bbox", {
        params: {
          query: {
            min_lng: params.minLng,
            min_lat: params.minLat,
            max_lng: params.maxLng,
            max_lat: params.maxLat,
            ...(params.kinds && params.kinds.length > 0
              ? { kinds: params.kinds }
              : {}),
            ...(params.limit != null ? { limit: params.limit } : {}),
          },
        },
        ...reqSignal(init),
      }),
    ),
  getInCorridor: (data: CorridorInput, init?: RequestInit) =>
    openApiData<StoredCorridorResponse>(
      api.POST("/api/v1/poi/in-corridor", {
        body: data as JsonRequest<"/api/v1/poi/in-corridor", "post">,
        ...reqSignal(init),
      }),
    ),
};
