/**
 * Base URL for the backend (host only, no path prefix).
 * Defaults to empty string (same-origin) so client-side fetches resolve
 * against the current origin — works with Next.js rewrites/proxies in prod.
 * Strips any trailing /api/v1 in case the env var includes it.
 */
export const API_HOST = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(
  /\/(api\/)?v1\/?$/,
  "",
);

/** Base URL with the API version prefix, for raw fetch calls. */
export const API_BASE = `${API_HOST}/api/v1`;

/**
 * Absolute host for server-side use (SSR reads, JWT callbacks, etc.).
 * Server-side fetch needs a full URL — relative paths don't resolve. This is
 * the host only (no `/api/v1`), matching the `baseUrl` the generated client
 * expects since the spec paths already carry the `/api/v1` prefix.
 */
export const API_HOST_SERVER = API_HOST || "http://localhost:3000";

/**
 * Absolute base URL for server-side use (JWT callbacks, etc.).
 * Server-side fetch needs a full URL — relative paths don't resolve.
 */
export const API_BASE_SERVER = `${API_HOST_SERVER}/api/v1`;

/**
 * Read an optional NEXT_PUBLIC_* value that the container build ALWAYS
 * materializes: the Dockerfile maps every optional TARMOTO_* build arg to
 * its NEXT_PUBLIC_* twin unconditionally, so an unset arg arrives here as
 * an EMPTY STRING — which `??` waves through. Blank must mean "use the
 * default": an empty MAP_STYLE_URL reached `new maplibregl.Map({style:""})`,
 * which builds a STYLELESS map (maplibre only applies truthy styles) and
 * crashed every map page on the first Coolify deploy (#1255).
 */
export function envOrDefault(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Base MapLibre style URL. Companion maps apply Tarmoto restyling and a
 * dark-mode variant at runtime while this env still allows pointing at a
 * different hosted basemap when needed (e.g. local development).
 */
export const MAP_STYLE_URL = envOrDefault(
  process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  "https://tiles.openfreemap.org/styles/liberty",
);

/**
 * Raster tile URL template for the planner's aerial basemap. Defaults to the
 * public ČÚZK orthophoto tile service (WMTS-compatible REST endpoint, no key
 * required); point NEXT_PUBLIC_AERIAL_TILES_URL at a different XYZ/WMTS/WMS
 * template to override.
 */
export const AERIAL_TILES_URL = envOrDefault(
  process.env.NEXT_PUBLIC_AERIAL_TILES_URL,
  // The ORTOFOTO service moved off /arcgis/ — /arcgis1/ is the live
  // instance (the old path 404s and left the Aerial toggle blank).
  "https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}",
);

/** Attribution line shown while the aerial basemap is active. */
export const AERIAL_ATTRIBUTION = "© ČÚZK";
