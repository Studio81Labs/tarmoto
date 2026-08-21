import { API_BASE } from "@/lib/config";

/**
 * Absolute base of the backend's vector-tile route, ending in a slash.
 *
 * One definition for BOTH the tile source URLs and the `transformRequest`
 * predicate that stamps them with the rider's tile credential (#1279). If the
 * two were spelled separately, a change to one would silently stop the other
 * matching — and the failure mode is invisible: tiles keep loading, just
 * anonymously, so a paying rider quietly drops back to the free zoom cap.
 *
 * `API_BASE` may be absolute (production: a separate api host) or relative (a
 * same-origin proxy), so the browser origin is prepended only in the second
 * case — mirroring how MapLibre resolves the URLs it is handed.
 */
export function backendTileUrlBase(): string {
  const origin =
    typeof window === "undefined" || API_BASE.startsWith("http")
      ? ""
      : window.location.origin;
  return `${origin}${API_BASE}/roads/tiles/`;
}

/**
 * Tile layer sets whose bytes depend on `road_quality_max_zoom`. Only these
 * are worth a credential: `surface` and `hazards` are never clamped, so
 * stamping them would buy nothing and cost twice — an account lookup per tile
 * on the backend, and a per-rider, per-rotation cache key that takes those
 * otherwise identical responses out of shared CDN reuse entirely.
 */
const QUALITY_BEARING_LAYERS = new Set(["all", "quality"]);

/**
 * MapLibre `transformRequest` that appends the rider's scoped tile credential
 * to backend QUALITY tile requests — and to nothing else (#1279).
 *
 * The origin scoping is the security property, not a nicety: the same map
 * fetches its style, sprites, glyphs and basemap tiles from OpenFreeMap and
 * its aerial imagery from ČÚZK, and MapLibre routes every one of those through
 * this same hook. The prefix test is a `startsWith` against the absolute
 * backend tile base, so a third-party URL that merely CONTAINS that base (a
 * redirect target in a query string, say) does not match either.
 *
 * Returning `undefined` leaves the request exactly as MapLibre built it, which
 * is also the no-credential path: with no token the tiles are fetched
 * anonymously and the backend clamps quality to the free tier. A tile fetch is
 * one of ~40 in a viewport with no retry hook, so degrading is the only
 * acceptable behaviour for a missing or rotated-out credential — never a
 * failed request.
 */
export function createTileTransformRequest(
  tileUrlBase: string,
  getTileToken: () => string | null,
): (url: string) => { url: string } | undefined {
  return (url: string) => {
    if (!url.startsWith(tileUrlBase)) return undefined;
    // Safe to parse: the prefix test above already established this is one of
    // our own absolute tile URLs. `layers` absent means the server default,
    // `all`, which does include quality.
    const layers = new URL(url).searchParams.get("layers") ?? "all";
    if (!QUALITY_BEARING_LAYERS.has(layers)) return undefined;
    const token = getTileToken();
    if (!token) return undefined;
    const separator = url.includes("?") ? "&" : "?";
    return { url: `${url}${separator}tile_token=${encodeURIComponent(token)}` };
  };
}
