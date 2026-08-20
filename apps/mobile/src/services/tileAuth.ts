/**
 * Identity on road-quality tile fetches (#1279).
 *
 * `road_quality_max_zoom` is the last client-trusted paid gate: #1108 added the
 * server-side clamp on `GET /roads/tiles/:z/:x/:y.mvt`, but its anonymous leg
 * had to ship dark because nothing the app fetched tiles with carried identity.
 * This module supplies it on both tile paths, with a different credential each:
 *
 *  - **The live MapLibre sources** carry a short-lived, tile-scoped token as a
 *    URL search parameter, injected by MapLibre's own request transform.
 *    NOT the account bearer: the transform pipeline is registered on the shared
 *    native HTTP stack that also fetches the OpenFreeMap basemap, so although
 *    the `match` regex below scopes it to the backend's tile path, the blast
 *    radius of a mistake there must be a 15-minute tile token and never the
 *    rider's account credential. `addUrlSearchParam` also updates IN PLACE for
 *    a given id, so rotation costs nothing: the source's URL template never
 *    changes, and MapLibre keeps its tile cache.
 *  - **The offline-pack downloader** issues plain HTTP requests it builds
 *    itself, one URL at a time, so it can carry the bearer in a per-request
 *    `Authorization` header — strictly safer than a URL parameter, and never
 *    routed through MapLibre at all. That side lives in `services/tileUrls.ts`
 *    (`authHeadersForTileUrl`), which is origin-scoped so the rule holds even
 *    if a caller hands it a foreign URL.
 */

import { AppState, type AppStateStatus } from "react-native";
import { TransformRequestManager } from "@maplibre/maplibre-react-native";
import { API_BASE_URL } from "@/config";
import { TILE_TOKEN_PARAM, backendTileUrlPattern } from "./tileUrls";

/** Stable transform id — re-adding it updates the value in place rather than
 *  stacking a second transform on every rotation. */
const TILE_TOKEN_TRANSFORM_ID = "tarmoto-tile-token";

/** Retry cadence after a failed mint. Short enough that a rider who regains
 *  signal mid-ride gets their overlay back, long enough not to be a loop. */
const MINT_RETRY_MS = 30_000;

/** Treat a token as spent slightly early so a request already in flight when it
 *  expires is not the one that discovers it. */
const EXPIRY_SKEW_MS = 5_000;

let tokenExpiryMs = 0;
let nextRotationAtMs = 0;
let rotationTimer: ReturnType<typeof setTimeout> | null = null;
let monitorSubscription: { remove: () => void } | null = null;

/**
 * Rotate a little before the server's expiry rather than at it, and never
 * faster than every 30 s however short a TTL the server hands back. Derived
 * from `expires_in` so the backend owns the lifetime.
 */
export function tileTokenRotationMs(expiresInSeconds: number): number {
  return Math.max(30_000, Math.floor(expiresInSeconds * 600));
}

/**
 * Publish (or withdraw) the tile credential MapLibre appends to backend tile
 * requests. `null` withdraws it, which is never an error state: the tiles are
 * then fetched anonymously and the backend clamps quality to the free tier.
 */
export function applyTileToken(
  token: string | null,
  expiresInSeconds = 0,
  apiBase: string = API_BASE_URL,
): void {
  if (token === null) {
    TransformRequestManager.removeUrlSearchParam(TILE_TOKEN_TRANSFORM_ID);
    tokenExpiryMs = 0;
    return;
  }
  TransformRequestManager.addUrlSearchParam({
    id: TILE_TOKEN_TRANSFORM_ID,
    match: backendTileUrlPattern(apiBase),
    name: TILE_TOKEN_PARAM,
    value: token,
  });
  tokenExpiryMs = Date.now() + expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
}

export interface TileTokenMonitorDeps {
  /** True when a rider is signed in (typically `api.isAuthenticated`). */
  isAuthenticated: () => boolean;
  /** Mint a fresh credential (typically `api.mintTileToken`). */
  mint: () => Promise<{ token: string; expires_in: number }>;
}

/**
 * Keep the live map's tile credential fresh for as long as a rider is signed
 * in. Mounted once at the app root, keyed on the session, in the same
 * `start*Monitor` shape as the privacy and system-switch refreshers.
 *
 * Starting CLEARS any credential first, so a sign-out (or a second rider on the
 * same install) can never leave the previous rider's token attached to tile
 * requests — the store outlives the React tree that mounted it.
 */
export function startTileTokenMonitor(deps: TileTokenMonitorDeps): () => void {
  stopTileTokenMonitor();

  void rotate(deps);

  const onChange = (next: AppStateStatus) => {
    // Background timers are unreliable on both platforms, so a rider returning
    // to a long-suspended app may hold a token that expired while away. Rotate
    // on foreground, but only when actually due — a rider tabbing in and out
    // must not mint on every transition.
    if (next === "active" && Date.now() >= nextRotationAtMs) {
      void rotate(deps);
    }
  };
  const subscription = AppState.addEventListener("change", onChange);
  monitorSubscription = subscription;

  return () => {
    if (monitorSubscription === subscription) {
      stopTileTokenMonitor();
    } else {
      subscription.remove();
    }
  };
}

export function stopTileTokenMonitor(): void {
  if (rotationTimer !== null) {
    clearTimeout(rotationTimer);
    rotationTimer = null;
  }
  if (monitorSubscription) {
    monitorSubscription.remove();
    monitorSubscription = null;
  }
  nextRotationAtMs = 0;
  applyTileToken(null);
}

async function rotate(deps: TileTokenMonitorDeps): Promise<void> {
  if (!deps.isAuthenticated()) {
    applyTileToken(null);
    return;
  }
  try {
    const minted = await deps.mint();
    applyTileToken(minted.token, minted.expires_in);
    schedule(tileTokenRotationMs(minted.expires_in), deps);
  } catch {
    // Best-effort: a rider in a tunnel must not lose the credential they
    // already hold — that would silently drop them to the free zoom cap. Only
    // a genuinely expired token is withdrawn, and the retry below picks the
    // rotation back up.
    if (tokenExpiryMs !== 0 && Date.now() >= tokenExpiryMs) {
      applyTileToken(null);
    }
    schedule(MINT_RETRY_MS, deps);
  }
}

function schedule(delayMs: number, deps: TileTokenMonitorDeps): void {
  if (rotationTimer !== null) clearTimeout(rotationTimer);
  nextRotationAtMs = Date.now() + delayMs;
  rotationTimer = setTimeout(() => {
    rotationTimer = null;
    void rotate(deps);
  }, delayMs);
}
