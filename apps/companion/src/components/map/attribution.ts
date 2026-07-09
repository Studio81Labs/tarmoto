import type { StyleSpecification } from "maplibre-gl";

// Curated, linked map attribution (#852).
//
// The base map style (OpenFreeMap) credits its providers through a TileJSON:
// its vector source carries no inline `attribution`, only a `url`, and MapLibre
// fetches that TileJSON and appends its plain-text blob — "OpenFreeMap ©
// OpenMapTiles Data from OpenStreetMap" — to the attribution control once tiles
// load. We inline that TileJSON on style load (see loadCuratedMapStyle) so the
// blob never appears, then drive the control with BASE_MAP_ATTRIBUTION below:
// linked, and in a fixed provenance order. Every provider stays credited — this
// only reformats, it never drops one.

/**
 * The canonical OpenStreetMap credit. Exported so the POI GeoJSON source can
 * reuse the exact same string: MapLibre's control drops any entry that is a
 * substring of a longer one, so the POI layer's OSM credit collapses into the
 * base-map credit below and OSM is shown exactly once.
 */
export const OSM_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';

/**
 * Foursquare OS Places credit (#869) — the second bulk POI source. Apache-2.0 +
 * the dataset's NOTICE.txt require preserving attribution to Foursquare; this is
 * the linked short form (the full NOTICE lives in the runbook). Shown only when
 * FSQ POIs are actually present (data-driven), so it never credits a source that
 * isn't contributing while FSQ stays disabled by default.
 */
export const FSQ_ATTRIBUTION =
  '<a href="https://foursquare.com" target="_blank" rel="noopener noreferrer">© Foursquare</a>';

/** Foursquare brand blue (PMS 307) — the FSQ legend dot / provenance marker. */
export const FSQ_BRAND_COLOR = "#0072b1";

const OPENMAPTILES_ATTRIBUTION =
  '<a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a>';

const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>';

/**
 * Base-map credits in provenance order — raw data → tile schema → tile host.
 * Passed to the attribution control joined into a single string so this order
 * survives (the control length-sorts multiple entries but never reorders one).
 */
export const BASE_MAP_ATTRIBUTION: string[] = [
  OSM_ATTRIBUTION,
  OPENMAPTILES_ATTRIBUTION,
  OPENFREEMAP_ATTRIBUTION,
];

/**
 * Whether {@link loadCuratedMapStyle} + {@link BASE_MAP_ATTRIBUTION} apply to a
 * style URL. The curation strips **every** source's baked-in attribution and
 * replaces it with the OpenFreeMap-specific credits above, so it is correct
 * only for an OpenFreeMap-hosted style. A different `NEXT_PUBLIC_MAP_STYLE_URL`
 * (a commercial or self-hosted provider) must be passed through untouched, so it
 * keeps its own required attribution and resolves its relative sprite/glyph/tile
 * paths against the style URL rather than the companion origin.
 */
export function isCuratableBaseMap(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "openfreemap.org" || host.endsWith(".openfreemap.org");
  } catch {
    return false;
  }
}

// TileJSON fields that describe where/how to fetch a source's tiles. We copy
// these onto the source when inlining so it renders without its `url` — and
// pointedly omit `attribution`, which is the whole reason for inlining.
const TILEJSON_TILE_FIELDS = [
  "tiles",
  "minzoom",
  "maxzoom",
  "bounds",
  "scheme",
] as const;

/**
 * Fetch the base map style and neutralise its provider attribution so the
 * control shows only our curated {@link BASE_MAP_ATTRIBUTION}. Assumes an
 * OpenFreeMap-family style — gate the call with {@link isCuratableBaseMap},
 * since this strips **all** source attribution:
 *
 * - a source that references a TileJSON (`url`) has its tile config inlined and
 *   its `url` dropped, so MapLibre never fetches the TileJSON whose attribution
 *   it would otherwise append;
 * - any inline `attribution` is stripped too.
 *
 * Degrades gracefully: a source whose TileJSON can't be fetched keeps its `url`
 * (so the map still renders, with the provider's own credit), and a style that
 * can't be fetched at all falls back to the original URL. Returns the value to
 * hand straight to `new maplibregl.Map({ style })`.
 */
export async function loadCuratedMapStyle(
  url: string,
): Promise<StyleSpecification | string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const style = (await res.json()) as StyleSpecification;
    await Promise.all(
      Object.values(style.sources ?? {}).map(async (source) => {
        if (!source || typeof source !== "object") return;
        const spec = source as Record<string, unknown>;
        if (typeof spec.url === "string") {
          try {
            const tileJson = (await fetch(spec.url).then((r) =>
              r.ok ? r.json() : null,
            )) as Record<string, unknown> | null;
            if (tileJson) {
              for (const field of TILEJSON_TILE_FIELDS) {
                if (tileJson[field] !== undefined)
                  spec[field] = tileJson[field];
              }
              delete spec.url;
            }
          } catch {
            // TileJSON unreachable: leave `url` so the map still renders.
          }
        }
        delete spec.attribution;
      }),
    );
    return style;
  } catch {
    return url;
  }
}
