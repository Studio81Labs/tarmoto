/**
 * Offline map regions — US-18 AC #1 "Download map regions for offline use".
 *
 * The road-quality overlay and future basemap live behind the backend's
 * MVT tile endpoint (`/api/v1/roads/tiles/{z}/{x}/{y}.mvt?layers=quality`). When a
 * rider is about to head into a rural area we want those tiles cached on
 * disk so the map still renders without cell service. This module is the
 * caching backbone:
 *
 *   - Pure tile-math helpers convert a geographic bbox + zoom range into
 *     the list of (z, x, y) tiles that cover it. Trivially unit-testable
 *     without MapLibre or the filesystem.
 *
 *   - A downloader walks that list, pulls each tile over HTTP via
 *     `react-native-fs`, writes it to a per-region directory under
 *     `DocumentDirectoryPath/offline-tiles/<regionId>/<z>/<x>/<y>.mvt`,
 *     and reports progress through a callback. Failures are recorded
 *     so the region can be retried later without re-downloading tiles
 *     that already succeeded.
 *
 * Serving the cached tiles to MapLibre (e.g. via a local HTTP proxy or a
 * `file://` vector source) is a separate slice — this module just makes
 * sure the bytes are on disk. See the module-level comment in
 * `MapScreen.tsx` for the division of labour.
 *
 * Non-goals:
 *   - Automatic eviction (we tell the rider how much space they're using
 *     and let them delete regions manually).
 *   - Offline routing / turn-by-turn (US-18 AC #2 — separate workstream).
 *   - Basemap style JSON + glyphs/sprites (follow-up once the Tarmoto
 *     basemap ships; see `APP_MAP_STYLE_URL`).
 */

import { API_BASE_URL } from "@/config";
import type { LatLng } from "@/types";
import { authHeadersForTileUrl, backendTileUrlBase } from "./tileUrls";

// ── Types ──

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface OfflineRegionSpec {
  /** Stable client-generated id. Used as the on-disk directory name too. */
  id: string;
  /** Rider-visible name (e.g. "Beskydy weekend"). */
  name: string;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  createdAt: number;
  /**
   * The rider who downloaded this pack, or `null` for one downloaded before
   * packs were attributed (#1279).
   *
   * REQUIRED, so no call site can register a pack without deciding. Since tile
   * fetches carry identity, a pack's contents are shaped by its downloader's
   * `road_quality_max_zoom` — deep-zoom quality for a paying rider, clamped
   * empties for a free one. The store is device-global and survives sign-out,
   * so without an owner a second rider on the same device would read the
   * first's pack straight past their own clamp. See {@link isRegionUsableBy}.
   */
  ownerId: string | null;
}

export type RegionStatus =
  "pending" | "downloading" | "complete" | "failed" | "cancelled";

/**
 * Stable persisted failure reasons. Render these through the active catalog at
 * the UI boundary; never persist already-translated copy because it survives a
 * later language change and can remain stale across app restarts.
 */
export type OfflineRegionError =
  | {
      code: "tile-cap-exceeded";
      limit: number;
      count: number;
    }
  | { code: "download-failed" };

export interface OfflineRegion extends OfflineRegionSpec {
  status: RegionStatus;
  /** Total tiles in the region (constant once computed). */
  totalTiles: number;
  /** Tiles already on disk. Monotonic while `status === "downloading"`. */
  downloadedTiles: number;
  /** Tiles that failed this attempt — bounded by `totalTiles - downloaded`. */
  failedTiles: number;
  /** Sum of bytes written. Best-effort — 0 until the first tile completes. */
  bytesOnDisk: number;
  /** Stable failure reason, localized only when rendered. */
  lastError: OfflineRegionError | null;
  /** ms timestamp of the most recent successful tile write. */
  lastUpdatedAt: number | null;
}

/**
 * Whether `riderId` may read, resume or see this pack (#1279).
 *
 * The rule is EXCLUDE, not purge — deliberately, and consistent with how the
 * rest of the offline feature already behaves: `MapScreen` gates the on-disk
 * read on `offline_maps` and leaves the bytes alone, and its own comment says
 * why (a rider must still be able to open the screen and delete them). Sign-out
 * likewise clears credentials and cached preferences, never downloaded content.
 * So another rider's pack becomes invisible and unusable rather than deleted,
 * and its owner gets it back — and can reclaim the disk — when they sign in.
 *
 * A pack with no owner predates attribution. Those are ADOPTED on first sight
 * by whoever is signed in (see the store's `adoptUnownedRegions`), which mirrors
 * the user-id backfill `refreshPrivacyPreferences` already does for upgraded
 * installs: the rider holding the device at upgrade time keeps their downloads,
 * and a later, different rider does not inherit them.
 */
export function isRegionUsableBy(
  region: Pick<OfflineRegion, "ownerId">,
  riderId: string | null,
): boolean {
  if (region.ownerId === null) return true;
  return region.ownerId === riderId;
}

/**
 * The deepest zoom worth downloading for a rider whose resolved
 * `road_quality_max_zoom` is `qualityMaxZoom` (#1279).
 *
 * Packs hold `layers=quality` tiles only, and the backend withholds that layer
 * above the requester's cap — so a capped rider asking for the default z8–14
 * range spends a request per tile on z13 and z14 to be handed a 204. Those are
 * not failures (the server is answering honestly, and the rider is not entitled
 * to the data), so they cannot be treated as ones without making a capped
 * rider's region permanently un-completable. Not requesting them is the honest
 * fix: the pack then holds exactly what its owner may see, and completes.
 *
 * `isResolved` false returns the request unchanged rather than guessing — a cap
 * that has not resolved must not silently shrink a paying rider's pack. In
 * practice the download screen already gates itself on resolved entitlements,
 * so this is a guard rather than a live path.
 */
export function clampRegionMaxZoom(
  requestedMaxZoom: number,
  qualityMaxZoom: number | null,
  isResolved: boolean,
): number {
  if (!isResolved || qualityMaxZoom === null) return requestedMaxZoom;
  return Math.min(requestedMaxZoom, qualityMaxZoom);
}

export interface DownloadProgress {
  regionId: string;
  downloaded: number;
  failed: number;
  total: number;
  bytesOnDisk: number;
}

/** Callback shape used to push progress into the store. */
export type ProgressReporter = (update: DownloadProgress) => void;

/** Injected HTTP+FS port. Lets tests avoid the native bindings entirely. */
export interface TileDownloader {
  /**
   * Fetch a single tile and persist it at `destPath`. Resolves with the
   * number of bytes written. Rejects on any failure (404, 5xx, network).
   */
  downloadTile(tileUrl: string, destPath: string): Promise<number>;
  /** Ensure a directory exists. Equivalent to `mkdir -p`. */
  ensureDir(dirPath: string): Promise<void>;
  /** Remove a directory tree (idempotent). */
  removeDir(dirPath: string): Promise<void>;
  /** `true` if the tile is already on disk. */
  tileExists(destPath: string): Promise<boolean>;
  /**
   * Size in bytes of an existing tile. Used to account for disk usage on
   * the resume path. Implementations should return 0 on missing files or
   * stat errors rather than throwing — a stat failure shouldn't abort a
   * whole region download.
   */
  fileSize(destPath: string): Promise<number>;
}

// ── Constants ──

/** Hard cap to stop riders accidentally queuing a continent-sized region. */
export const MAX_TILES_PER_REGION = 5000;

/** Floor on minZoom to keep URLs sane — below z=0 is meaningless. */
export const ZOOM_BOUNDS = { min: 0, max: 16 } as const;

/** Root of all per-region tile caches on disk. Relative to the doc dir. */
export const OFFLINE_ROOT_DIRNAME = "offline-tiles";

// ── Pure tile-math helpers ──

/**
 * Clamp a zoom pair to `ZOOM_BOUNDS` and ensure min <= max. Returns the
 * validated pair or throws when the caller's numbers are nonsense (NaN,
 * swapped, out of bounds even after clamping).
 *
 * Throwing here rather than silently normalising means the UI can surface
 * "invalid zoom range" in one place instead of guessing what the cache
 * did with the rider's input.
 */
export function normalizeZoomRange(
  minZoom: number,
  maxZoom: number,
): { minZoom: number; maxZoom: number } {
  if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom)) {
    throw new Error("Zoom values must be finite numbers");
  }
  const min = Math.max(
    ZOOM_BOUNDS.min,
    Math.min(ZOOM_BOUNDS.max, Math.floor(minZoom)),
  );
  const max = Math.max(
    ZOOM_BOUNDS.min,
    Math.min(ZOOM_BOUNDS.max, Math.floor(maxZoom)),
  );
  if (min > max) {
    throw new Error(`minZoom (${min}) must be <= maxZoom (${max})`);
  }
  return { minZoom: min, maxZoom: max };
}

/**
 * Convert a geographic bbox at a zoom level into the inclusive (x, y) tile
 * range covering it. Uses the standard Web Mercator tile scheme — same
 * math MapLibre uses internally so the cached tiles line up with what the
 * online map would have requested.
 *
 * Latitude is clamped to the Mercator-safe range (±85.0511) because
 * tan(90°) is undefined — a rider panning to the pole shouldn't crash the
 * region calculator.
 */
export function tileRangeForBBox(
  bbox: BBox,
  zoom: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const n = 2 ** zoom;
  // Tile X from longitude.
  const xMin = Math.floor(((bbox.west + 180) / 360) * n);
  const xMax = Math.floor(((bbox.east + 180) / 360) * n);
  // Tile Y from latitude. Using the sinh/ln formulation avoids tan near
  // the poles and matches the OSM slippy-map convention.
  const yMin = latToTileY(bbox.north, zoom);
  const yMax = latToTileY(bbox.south, zoom);
  return {
    xMin: Math.max(0, Math.min(n - 1, xMin)),
    xMax: Math.max(0, Math.min(n - 1, xMax)),
    yMin: Math.max(0, Math.min(n - 1, yMin)),
    yMax: Math.max(0, Math.min(n - 1, yMax)),
  };
}

function latToTileY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  const n = 2 ** zoom;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
}

/**
 * Enumerate every tile covered by the bbox over the inclusive zoom range.
 * Ordered from lowest zoom (fewest tiles, biggest coverage) to highest
 * zoom so the first tiles downloaded give the rider a usable low-detail
 * preview even if the job is interrupted — losing the inner zoom levels
 * is less painful than losing the overview.
 */
export function enumerateTilesForRegion(
  bbox: BBox,
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const { minZoom: zMin, maxZoom: zMax } = normalizeZoomRange(minZoom, maxZoom);
  const tiles: TileCoord[] = [];
  for (let z = zMin; z <= zMax; z += 1) {
    const range = tileRangeForBBox(bbox, z);
    for (let x = range.xMin; x <= range.xMax; x += 1) {
      for (let y = range.yMin; y <= range.yMax; y += 1) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

/**
 * Convenience — returns just the tile count without materialising the full
 * array. Used by the UI to show "this region will use ~N tiles" before the
 * rider commits to the download, and to enforce `MAX_TILES_PER_REGION`.
 */
export function countTilesForRegion(
  bbox: BBox,
  minZoom: number,
  maxZoom: number,
): number {
  const { minZoom: zMin, maxZoom: zMax } = normalizeZoomRange(minZoom, maxZoom);
  let count = 0;
  for (let z = zMin; z <= zMax; z += 1) {
    const range = tileRangeForBBox(bbox, z);
    const width = range.xMax - range.xMin + 1;
    const height = range.yMax - range.yMin + 1;
    count += width * height;
  }
  return count;
}

// ── URL + path helpers ──

/**
 * Build the URL for a single tile. Mirrors the template the online
 * `VectorSource` uses so a cached tile is byte-equivalent to the one
 * MapLibre would have fetched, keeping the style expressions valid.
 */
export function tileUrl(
  tile: TileCoord,
  apiBase: string = API_BASE_URL,
): string {
  // Built from the shared base so the downloader's URLs and the origin test
  // that decides whether to attach the rider's bearer (#1279) can never drift
  // apart — if they did, the packs would silently download anonymously.
  return `${backendTileUrlBase(apiBase)}${tile.z}/${tile.x}/${tile.y}.mvt?layers=quality`;
}

/**
 * Build the on-disk path for a tile inside a region. Kept as a pure helper
 * so the downloader, tests, and a future MapLibre offline adapter can all
 * agree on where the bytes live without re-deriving the layout.
 */
export function tilePath(
  docsDir: string,
  regionId: string,
  tile: TileCoord,
): string {
  return `${regionDir(docsDir, regionId)}/${tile.z}/${tile.x}/${tile.y}.mvt`;
}

/** Directory holding every tile for one region. */
export function regionDir(docsDir: string, regionId: string): string {
  return `${docsDir}/${OFFLINE_ROOT_DIRNAME}/${regionId}`;
}

/** Directory inside a region that holds all tiles at one zoom level. */
export function zoomDir(
  docsDir: string,
  regionId: string,
  tile: TileCoord,
): string {
  return `${regionDir(docsDir, regionId)}/${tile.z}/${tile.x}`;
}

// ── BBox helpers ──

/**
 * Build a square-ish bbox around a centre point whose edge is
 * `radiusKm * 2`. Longitude spread widens as latitude leaves the equator
 * (meridian convergence) so the resulting bbox covers roughly the
 * requested radius on the ground, not a map-projected diamond.
 */
export function bboxAroundPoint(center: LatLng, radiusKm: number): BBox {
  const radius = Math.max(0.5, Math.min(200, radiusKm));
  const latDelta = radius / 111; // ~111 km per degree of latitude
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  // Guard the pole case (cos near zero) — fall back to a wide span rather
  // than dividing by ~0 and producing an infinite bbox.
  const lngDelta = radius / (111 * Math.max(0.01, cosLat));
  return {
    west: center.lng - lngDelta,
    east: center.lng + lngDelta,
    south: center.lat - latDelta,
    north: center.lat + latDelta,
  };
}

/**
 * Build a bbox from MapLibre's `visibleBounds` shape. Symmetrical to the
 * `bboxFromVisibleBounds` helper in `MapScreen.helpers.ts` but returns a
 * structured `BBox` instead of the `west,south,east,north` URL string.
 */
export function bboxFromVisibleBounds(
  visibleBounds: [[number, number], [number, number]],
): BBox {
  const [a, b] = visibleBounds;
  return {
    west: Math.min(a[0], b[0]),
    east: Math.max(a[0], b[0]),
    south: Math.min(a[1], b[1]),
    north: Math.max(a[1], b[1]),
  };
}

// ── Downloader ──

export interface DownloadRegionOptions {
  /** Spec describing where and what to cache. */
  spec: OfflineRegionSpec;
  /** Root dir for on-disk tiles (usually `RNFS.DocumentDirectoryPath`). */
  docsDir: string;
  /** HTTP+FS adapter. */
  downloader: TileDownloader;
  /** Backend base URL; defaults to the app-wide one. */
  apiBase?: string;
  /** Progress sink. Called at least once per tile processed. */
  onProgress?: ProgressReporter;
  /**
   * Optional predicate the downloader polls before each tile. Returning
   * `true` aborts the job cleanly; the region is left in-place so a later
   * retry can resume from where it stopped.
   */
  isCancelled?: () => boolean;
}

export interface DownloadRegionResult {
  status: Exclude<RegionStatus, "pending" | "downloading">;
  downloaded: number;
  failed: number;
  total: number;
  bytesOnDisk: number;
  error: OfflineRegionError | null;
}

/**
 * Download every tile in `spec` sequentially. Sequential (not parallel) on
 * purpose: mobile links are often the bottleneck and most backends rate-
 * limit aggressive parallel map-tile fetches. If the region's rate-limit
 * ceiling ever moves up, the right knob is a small N-at-a-time worker
 * pool — not unbounded `Promise.all` on thousands of URLs.
 *
 * Tiles already on disk (from a previous partial run) are counted as
 * `downloaded` without re-fetching, so a retry after a crash is nearly
 * free up to the failure point.
 */
export async function downloadRegion(
  opts: DownloadRegionOptions,
): Promise<DownloadRegionResult> {
  const {
    spec,
    docsDir,
    downloader,
    apiBase = API_BASE_URL,
    onProgress,
    isCancelled,
  } = opts;

  const tiles = enumerateTilesForRegion(spec.bbox, spec.minZoom, spec.maxZoom);

  if (tiles.length > MAX_TILES_PER_REGION) {
    return {
      status: "failed",
      downloaded: 0,
      failed: 0,
      total: tiles.length,
      bytesOnDisk: 0,
      error: {
        code: "tile-cap-exceeded",
        limit: MAX_TILES_PER_REGION,
        count: tiles.length,
      },
    };
  }

  await downloader.ensureDir(regionDir(docsDir, spec.id));

  let downloaded = 0;
  let failed = 0;
  let bytesOnDisk = 0;
  const total = tiles.length;

  const report = (): void => {
    onProgress?.({
      regionId: spec.id,
      downloaded,
      failed,
      total,
      bytesOnDisk,
    });
  };

  // Emit once before we start so the UI can flip to "downloading" with a
  // 0/N bar instead of staying on "pending" until the first tile lands.
  report();

  for (const tile of tiles) {
    if (isCancelled?.()) {
      return {
        status: "cancelled",
        downloaded,
        failed,
        total,
        bytesOnDisk,
        error: null,
      };
    }

    const dest = tilePath(docsDir, spec.id, tile);

    try {
      if (await downloader.tileExists(dest)) {
        // Resume path: assume the existing file is intact. Re-hashing every
        // tile would double the I/O for a tiny chance of catching corruption
        // that the next render would flag anyway. We do `stat` the file so
        // `bytesOnDisk` reflects actual storage — a stat failure falls back
        // to 0 rather than aborting the run.
        downloaded += 1;
        bytesOnDisk += await downloader.fileSize(dest).catch(() => 0);
        report();
        continue;
      }
      await downloader.ensureDir(zoomDir(docsDir, spec.id, tile));
      // Poll again HERE, not only at the top of the iteration: `tileExists`
      // and `ensureDir` above are both awaits, and cancellation now also means
      // "the rider changed" (#1279). A switch landing in that window would
      // otherwise fetch this one tile under the new rider's entitlement and
      // write it into the previous rider's pack, where `tileExists` makes
      // every later retry skip it.
      if (isCancelled?.()) {
        return {
          status: "cancelled",
          downloaded,
          failed,
          total,
          bytesOnDisk,
          error: null,
        };
      }
      const bytes = await downloader.downloadTile(tileUrl(tile, apiBase), dest);
      downloaded += 1;
      bytesOnDisk += bytes;
    } catch {
      failed += 1;
    }
    report();
  }

  if (failed === 0) {
    return {
      status: "complete",
      downloaded,
      failed,
      total,
      bytesOnDisk,
      error: null,
    };
  }

  return {
    status: "failed",
    downloaded,
    failed,
    total,
    bytesOnDisk,
    error: { code: "download-failed" },
  };
}

// ── Default downloader adapter ──

/**
 * Default `TileDownloader` implementation backed by `react-native-fs`.
 *
 * Loaded lazily so the pure helpers and the store stay importable under
 * Jest (where the native binding isn't linked). Tests inject a shim via
 * the `downloader` option on `downloadRegion`.
 */
export function createRNFSDownloader(
  getAccessToken: () => Promise<string | null>,
  apiBase: string = API_BASE_URL,
): TileDownloader {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RNFS = require("react-native-fs") as typeof import("react-native-fs");
  return {
    async downloadTile(tileUrlStr, destPath) {
      // #1279 — carry the rider's identity so the backend resolves
      // `road_quality_max_zoom` against THEM: without it a pro rider's pack
      // caches free-capped tiles from z13 up on disk. Resolved per tile, and
      // REFRESH-AWARE: a region download runs serially for minutes and can
      // outlive the one-hour access token, and these raw requests get none of
      // the typed client's 401-retry middleware, so a plain read would go
      // quietly anonymous halfway through a pack.
      const accessToken = await getAccessToken();
      const { promise } = RNFS.downloadFile({
        fromUrl: tileUrlStr,
        toFile: destPath,
        // Origin-scoped in `authHeadersForTileUrl`, so the bearer cannot travel
        // to a host we do not own even if the URL builder ever changes.
        headers: authHeadersForTileUrl(tileUrlStr, accessToken, apiBase),
        progressDivider: 100,
        // Without a timeout a flaky cell link can wedge the whole region
        // queue behind one stuck tile. These bounds are generous enough
        // that a slow-but-working link still succeeds, but short enough
        // that a truly dead socket falls through to the retry path.
        // iOS honours `backgroundTimeout` even with `background: false`.
        connectionTimeout: 15000,
        readTimeout: 30000,
        background: false,
      });
      const result = await promise;
      if (result.statusCode < 200 || result.statusCode >= 300) {
        // Best-effort cleanup so a half-written file doesn't get mistaken
        // for a valid tile on the next retry.
        await RNFS.unlink(destPath).catch(() => undefined);
        throw new Error(`Tile request failed with HTTP ${result.statusCode}`);
      }
      if (result.statusCode === 204) {
        // An empty tile has two causes the response cannot tell apart:
        // genuinely no roads here, or the quality layer withheld because the
        // request resolved below the rider's cap. Never PERSIST it — a
        // zero-byte file is what `tileExists` reads as done, so the resume path
        // would skip it forever and a pack downloaded during a credential gap
        // would stay permanently missing its paid deep-zoom tiles. Reading is
        // unaffected: a missing `file://` tile renders like a zero-byte one.
        await RNFS.unlink(destPath).catch(() => undefined);
        if (accessToken === null) {
          // What the response cannot tell apart, the REQUEST can: an empty tile
          // is only trustworthy if the request carried the identity it was
          // meant to. Without one this may well be the clamp, so fail the tile
          // — the region then ends `failed`, which is the only state whose UI
          // offers Retry. Counting it as downloaded would complete the region
          // and strand the rider with no way back short of deleting the pack.
          throw new Error("Tile request lost its credential mid-download");
        }
        return 0;
      }
      return result.bytesWritten;
    },
    async ensureDir(dirPath) {
      await RNFS.mkdir(dirPath);
    },
    async removeDir(dirPath) {
      if (await RNFS.exists(dirPath)) {
        await RNFS.unlink(dirPath);
      }
    },
    async tileExists(destPath) {
      return RNFS.exists(destPath);
    },
    async fileSize(destPath) {
      try {
        const stat = await RNFS.stat(destPath);
        return Number(stat.size) || 0;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Resolve the documents directory used as the cache root. Lazy so tests
 * don't have to fake the entire RNFS surface just to import the store.
 */
export function getDefaultDocsDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RNFS = require("react-native-fs") as typeof import("react-native-fs");
  return RNFS.DocumentDirectoryPath;
}
