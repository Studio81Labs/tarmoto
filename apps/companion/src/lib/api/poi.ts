import { apiFetch } from "./client";

// ── POI endpoints (US-36 / US-48 planner stops & stays) ──

export type AccommodationKind =
  | "hotel"
  | "motel"
  | "hostel"
  | "guest_house"
  | "apartment"
  | "chalet"
  | "camp_site";

export interface AccommodationSuggestion {
  external_id: string;
  name: string | null;
  kind: AccommodationKind;
  lat: number;
  lng: number;
  distance_km: number;
  website: string | null;
  phone: string | null;
  stars: number | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  osm_url: string | null;
  maps_url: string;
}

export interface AccommodationsResponse {
  accommodations: AccommodationSuggestion[];
  radius_km: number;
  kinds: AccommodationKind[];
}

export type PoiKind = "restaurant" | "viewpoint" | "cafe" | "fuel_station";

export interface RoutePoiSuggestion {
  external_id: string;
  name: string | null;
  kind: PoiKind;
  lat: number;
  lng: number;
  distance_along_route_km: number;
  distance_from_route_km: number;
  website: string | null;
  phone: string | null;
  hint: string | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  cuisine: string | null;
  brand: string | null;
  osm_url: string | null;
  maps_url: string;
}

export interface AlongRoutePoisResponse {
  pois: RoutePoiSuggestion[];
  buffer_km: number;
  kinds: PoiKind[];
  route_length_km: number;
}

/** A POI served from the offline `pois` store (`GET /poi/in-bbox`, #856). */
export interface StoredPoiSuggestion {
  id: string;
  source: string;
  external_id: string;
  name: string | null;
  kind: string;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
  opening_hours: string | null;
  address_street: string | null;
  address_city: string | null;
  address_postcode: string | null;
  address_country: string | null;
  cuisine: string | null;
  brand: string | null;
  stars: number | null;
  osm_url: string | null;
  maps_url: string;
  last_imported_at: string;
}

export interface StoredPoisResponse {
  pois: StoredPoiSuggestion[];
  count: number;
}

/** A stored POI matched against a route corridor (`POST /poi/in-corridor`, #859). */
export interface StoredCorridorPoiSuggestion extends StoredPoiSuggestion {
  distance_along_route_km: number;
  distance_from_route_km: number;
}

export interface StoredCorridorResponse {
  pois: StoredCorridorPoiSuggestion[];
  buffer_km: number;
  count: number;
}

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
  ) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
    });
    if (params.radius_km != null)
      query.set("radius_km", String(params.radius_km));
    if (params.min_stars != null)
      query.set("min_stars", String(params.min_stars));
    if (params.kinds && params.kinds.length > 0) {
      query.set("kinds", params.kinds.join(","));
    }
    return apiFetch<AccommodationsResponse>(
      `/poi/accommodations?${query.toString()}`,
      init,
    );
  },
  getAlongRoute: (
    data: {
      route: Array<{ lat: number; lng: number }>;
      buffer_km?: number;
      kinds?: PoiKind[];
    },
    init?: RequestInit,
  ) =>
    apiFetch<AlongRoutePoisResponse>("/poi/along-route", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
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
  ) => {
    const query = new URLSearchParams({
      min_lng: String(params.minLng),
      min_lat: String(params.minLat),
      max_lng: String(params.maxLng),
      max_lat: String(params.maxLat),
    });
    if (params.kinds && params.kinds.length > 0) {
      query.set("kinds", params.kinds.join(","));
    }
    if (params.limit != null) query.set("limit", String(params.limit));
    return apiFetch<StoredPoisResponse>(
      `/poi/in-bbox?${query.toString()}`,
      init,
    );
  },
  getInCorridor: (
    data: {
      route: Array<{ lat: number; lng: number }>;
      buffer_km?: number;
      kinds?: string[];
    },
    init?: RequestInit,
  ) =>
    apiFetch<StoredCorridorResponse>("/poi/in-corridor", {
      ...init,
      method: "POST",
      body: JSON.stringify(data),
    }),
};
