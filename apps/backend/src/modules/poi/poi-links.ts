/**
 * Outbound links for a POI — the "view source / view details" targets a rider
 * uses to decide whether it's the right place. Both are derivable from data we
 * already store (`external_id`, `name`, coordinates); no provider, no API key,
 * no request.
 */

/**
 * Build the canonical OpenStreetMap detail URL for a POI from its
 * `osm:<type>:<id>` external id — the rider-facing "view source" link and the
 * ODbL attribution target. Returns null for an id that isn't an OSM
 * node/way/relation reference.
 */
export function osmDetailUrl(externalId: string): string | null {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(externalId);
  if (!match) return null;
  return `https://www.openstreetmap.org/${match[1]}/${match[2]}`;
}

/**
 * Build a Google Maps deep link for a POI from its name + coordinates — the
 * richest free "photos & reviews" page for a rider, with **no Places API call
 * or key** (Google's documented Maps URLs scheme). We pass the name plus the
 * lat/lng so Google resolves the specific venue rather than just the point;
 * when the POI is unnamed we fall back to the coordinate alone. Always returns
 * a URL — coordinates are always present.
 */
export function googleMapsUrl(
  name: string | null,
  lat: number,
  lng: number,
): string {
  const trimmed = name?.trim();
  const query = trimmed ? `${trimmed} ${lat},${lng}` : `${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
