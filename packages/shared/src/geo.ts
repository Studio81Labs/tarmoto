const EARTH_RADIUS_M = 6371000;

/**
 * Haversine distance between two points.
 * @returns distance in meters
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Haversine distance between two points.
 * @returns distance in kilometers
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  return haversineMeters(lat1, lon1, lat2, lon2) / 1000;
}

/**
 * Convert a GeoJSON Point to a lat/lng object.
 * PostGIS stores coordinates as [lng, lat]; this swaps them.
 */
export function pointToLatLng(
  point: unknown,
): { lat: number; lng: number } | null {
  if (!point) return null;
  const geo = point as { coordinates: [number, number] };
  return { lat: geo.coordinates[1], lng: geo.coordinates[0] };
}

/**
 * Convert a lat/lng object to a GeoJSON Point.
 */
export function latLngToPoint(latLng: { lat: number; lng: number }): {
  type: "Point";
  coordinates: [number, number];
} {
  return { type: "Point", coordinates: [latLng.lng, latLng.lat] };
}
