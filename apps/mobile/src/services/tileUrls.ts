/**
 * Backend tile-URL shapes and the origin test that keeps credentials on them
 * (#1279).
 *
 * Kept free of the MapLibre and keychain bindings on purpose: the offline-pack
 * downloader needs these helpers and is deliberately importable under Jest
 * without any native module. `services/tileAuth.ts` builds the live-map side on
 * top of them.
 */

import { API_BASE_URL } from "@/config";

/** Query parameter the backend reads the scoped tile credential from. */
export const TILE_TOKEN_PARAM = "tile_token";

/**
 * Backend tile route, ending in a slash — the prefix every quality tile URL
 * (live overlay and offline download alike) is built from.
 */
export function backendTileUrlBase(apiBase: string = API_BASE_URL): string {
  return `${apiBase}/api/v1/roads/tiles/`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `match` pattern scoping MapLibre's credential transform to backend tile URLs.
 *
 * ANCHORED with `^` deliberately: both native implementations test the pattern
 * as a SUBSTRING search (Android `Regex.containsMatchIn`, iOS
 * `NSRegularExpression`), so an unanchored pattern would also match a
 * third-party URL that merely contains the backend base — a basemap style URL
 * carrying it in a query string, say. Emitted as a plain string with no flags:
 * the bridge rejects regex flags outright.
 */
export function backendTileUrlPattern(apiBase: string = API_BASE_URL): string {
  return `^${escapeRegExp(backendTileUrlBase(apiBase))}`;
}

/**
 * `Authorization` header for a tile URL, or no headers at all when the URL is
 * not a backend tile URL or there is no session.
 *
 * The origin test is the point: it makes "the rider's bearer never leaves our
 * own origin" a property of this function rather than of every call site's
 * discipline.
 */
export function authHeadersForTileUrl(
  url: string,
  accessToken: string | null,
  apiBase: string = API_BASE_URL,
): Record<string, string> {
  if (accessToken === null || accessToken === "") return {};
  if (!url.startsWith(backendTileUrlBase(apiBase))) return {};
  return { Authorization: `Bearer ${accessToken}` };
}
