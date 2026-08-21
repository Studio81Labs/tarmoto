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
 * `match` pattern scoping MapLibre's credential transform to backend QUALITY
 * tile URLs.
 *
 * ANCHORED with `^` deliberately: both native implementations test the pattern
 * as a SUBSTRING search (Android `Regex.containsMatchIn`, iOS
 * `NSRegularExpression`), so an unanchored pattern would also match a
 * third-party URL that merely contains the backend base — a basemap style URL
 * carrying it in a query string, say. Emitted as a plain string with no flags:
 * the bridge rejects regex flags outright.
 *
 * Narrowed to `layers=quality` for the same reason the companion's predicate
 * is: `surface` tiles are never clamped, so their bytes are identical for every
 * requester — stamping them would give each rider, and each rotation, a
 * distinct cache key for a public response and take the personal road map's
 * tiles out of shared CDN reuse entirely. The backend already ignores identity
 * on those requests; this keeps the URL clean too.
 *
 * Deliberately literal rather than clever: a source that ever asked for
 * `layers=all` would go un-stamped and fall back to the anonymous free view,
 * which is the safe direction, and no such source exists (`MapScreen` is the
 * only quality source, and offline packs read `file://`).
 */
export function backendTileUrlPattern(apiBase: string = API_BASE_URL): string {
  return `^${escapeRegExp(backendTileUrlBase(apiBase))}.*[?&]layers=quality`;
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

/**
 * Did the backend RESOLVE an identity for this tile response? `null` when the
 * headers do not say (#1279).
 *
 * The tile route marks an identified response `Cache-Control: private` and an
 * anonymous one `public`, precisely so a shared cache cannot serve one for the
 * other — which makes that header the only honest signal of whether a bearer we
 * SENT was actually accepted. A token can be present and still rejected: a
 * rotated JWT secret, an account deleted remotely, enough device clock skew.
 * `OptionalAuthGuard` deliberately serves those anonymously rather than
 * failing, so the request looks fine and the tile comes back clamped.
 *
 * `null` rather than `false` when nothing can be read: absence of evidence is
 * not evidence of an anonymous response, and callers should not fail a tile on
 * a header they never received.
 */
export function wasTileResponseIdentified(
  headers: Record<string, string> | undefined,
): boolean | null {
  if (!headers) return null;
  // Regex rather than case conversion: these are ASCII protocol tokens, not
  // rider-facing text, so there is no locale to fold them against.
  const key = Object.keys(headers).find((name) =>
    /^cache-control$/i.test(name),
  );
  if (key === undefined) return null;
  const value = headers[key];
  if (typeof value !== "string") return null;
  return /\bprivate\b/i.test(value);
}
