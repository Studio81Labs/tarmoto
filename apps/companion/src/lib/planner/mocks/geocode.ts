import { haversineKm } from "@tarmoto/shared";
import type { GeoResult } from "../types";

/**
 * MOCK geocoding for the planner's typed waypoint search and for naming
 * map-placed pins. Real target is a self-hosted Nominatim/Photon — the
 * swap happens in `../api.ts` only. Fixtures cover the central-Europe
 * corridor the local Valhalla tiles serve (CZ / AT / SI / HR / HU).
 */
export const GEOCODE_FIXTURES: GeoResult[] = [
  { name: "Praha", lat: 50.0755, lng: 14.4378 },
  { name: "Brno", lat: 49.1951, lng: 16.6068 },
  { name: "Ostrava", lat: 49.8209, lng: 18.2625 },
  { name: "Jihlava", lat: 49.3961, lng: 15.5912 },
  { name: "Pardubice", lat: 50.0343, lng: 15.7812 },
  { name: "Velké Meziříčí", lat: 49.3553, lng: 16.0122 },
  { name: "Žďár nad Sázavou", lat: 49.5626, lng: 15.9392 },
  { name: "České Budějovice", lat: 48.9745, lng: 14.4747 },
  { name: "Telč", lat: 49.1842, lng: 15.4528 },
  { name: "Znojmo", lat: 48.8555, lng: 16.0488 },
  { name: "Wien", lat: 48.2082, lng: 16.3738 },
  { name: "Graz", lat: 47.0707, lng: 15.4395 },
  { name: "Linz", lat: 48.3069, lng: 14.2858 },
  { name: "Salzburg", lat: 47.8095, lng: 13.055 },
  { name: "Klagenfurt", lat: 46.6247, lng: 14.3053 },
  { name: "Ljubljana", lat: 46.0569, lng: 14.5058 },
  { name: "Maribor", lat: 46.5547, lng: 15.6459 },
  { name: "Zagreb", lat: 45.815, lng: 15.9819 },
  { name: "Karlovac", lat: 45.487, lng: 15.5478 },
  { name: "Rijeka", lat: 45.3271, lng: 14.4422 },
  { name: "Zadar", lat: 44.1194, lng: 15.2314 },
  { name: "Šibenik", lat: 43.7272, lng: 15.9058 },
  { name: "Split", lat: 43.5081, lng: 16.4402 },
  { name: "Budapest", lat: 47.4979, lng: 19.0402 },
  { name: "Győr", lat: 47.6875, lng: 17.6504 },
];

/** Strip diacritics so "Zdar" matches "Žďár". */
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function mockGeocode(query: string): GeoResult[] {
  const needle = normalize(query.trim());
  if (needle.length < 2) return [];
  return GEOCODE_FIXTURES.filter((fixture) =>
    normalize(fixture.name).includes(needle),
  )
    .sort((a, b) => {
      // Prefix matches first, then alphabetical — deterministic ordering.
      const aPrefix = normalize(a.name).startsWith(needle) ? 0 : 1;
      const bPrefix = normalize(b.name).startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    })
    .slice(0, 5);
}

/** Nearest fixture within this radius names a reverse-geocoded pin. */
const REVERSE_MAX_KM = 30;

export function mockReverseGeocode(lat: number, lng: number): string {
  let best: GeoResult | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const fixture of GEOCODE_FIXTURES) {
    const km = haversineKm(fixture.lat, fixture.lng, lat, lng);
    if (km < bestKm) {
      bestKm = km;
      best = fixture;
    }
  }
  if (best && bestKm <= REVERSE_MAX_KM) {
    // "near X" when the pin isn't in town itself.
    return bestKm <= 5 ? best.name : `near ${best.name}`;
  }
  return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
}
