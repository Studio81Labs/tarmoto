import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StreetImage,
  StreetImageBytes,
  StreetImageryProvider,
} from '../mapillary-provider.interface.js';

interface MapillaryImageRow {
  id?: string;
  // Unix epoch milliseconds.
  captured_at?: number;
  thumb_1024_url?: string;
  compass_angle?: number;
  is_pano?: boolean;
  creator?: { username?: string };
}

const MAPILLARY_GRAPH_BASE = 'https://graph.mapillary.com';
const MAPILLARY_IMAGES_ENDPOINT = `${MAPILLARY_GRAPH_BASE}/images`;
const MAPILLARY_FETCH_TIMEOUT_MS = 6_000;
// Mapillary's radius search caps `radius` at 50 m and returns up to `limit`
// images near the point. Pull a handful so we can prefer a forward-facing,
// non-panoramic frame rather than whatever comes back first.
const SEARCH_RADIUS_M = 50;
const SEARCH_LIMIT = 10;
const IMAGE_FIELDS =
  'id,captured_at,thumb_1024_url,compass_angle,is_pano,creator';

/** Public Mapillary viewer page for an image — the attribution credit link. */
function mapillaryImageLink(imageId: string): string {
  return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(imageId)}&focus=photo`;
}

/**
 * Mapillary Graph API v4 street-level imagery provider (ADR-0009).
 *
 * Requires a client access token (`TARMOTO_MAPILLARY_TOKEN`). Without it the
 * provider is inert (returns null), so the Road Preview simply shows no imagery
 * instead of erroring. Mapillary imagery is CC-BY-SA — the caller MUST surface
 * the `attribution` + `link` this returns. Thumbnails are streamed through our
 * own proxy (see {@link thumbnail}) so the rider's browser never contacts
 * Mapillary's CDN.
 */
@Injectable()
export class MapillaryGraphProvider implements StreetImageryProvider {
  private readonly logger = new Logger(MapillaryGraphProvider.name);
  private readonly token: string | undefined;

  constructor(config: ConfigService) {
    this.token =
      config.get<string>('TARMOTO_MAPILLARY_TOKEN')?.trim() || undefined;
    if (!this.token) {
      this.logger.warn(
        'TARMOTO_MAPILLARY_TOKEN not set — Road Preview street-level imagery is disabled.',
      );
    }
  }

  async nearestImage(
    lat: number,
    lng: number,
    bearing?: number,
  ): Promise<StreetImage | null> {
    if (!this.token) return null;

    const url = new URL(MAPILLARY_IMAGES_ENDPOINT);
    url.searchParams.set('fields', IMAGE_FIELDS);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));
    url.searchParams.set('radius', String(SEARCH_RADIUS_M));
    url.searchParams.set('limit', String(SEARCH_LIMIT));

    const response = await this.fetchWithTimeout(url.toString(), true);
    if (!response.ok) {
      throw new Error(
        `Mapillary API error: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as { data?: MapillaryImageRow[] };
    return this.pickBest(body.data ?? [], bearing);
  }

  async thumbnail(imageId: string): Promise<StreetImageBytes | null> {
    if (!this.token) return null;

    // Resolve the current thumbnail URL for this id (Mapillary CDN URLs are
    // signed + expiring, so we never persist them — re-resolve on demand).
    const metaUrl = new URL(`${MAPILLARY_GRAPH_BASE}/${imageId}`);
    metaUrl.searchParams.set('fields', 'thumb_1024_url');
    const metaResponse = await this.fetchWithTimeout(metaUrl.toString(), true);
    if (!metaResponse.ok) {
      throw new Error(
        `Mapillary API error: ${metaResponse.status} ${metaResponse.statusText}`,
      );
    }
    const meta = (await metaResponse.json()) as { thumb_1024_url?: string };
    if (!meta.thumb_1024_url) return null;

    // Fetch the bytes from the CDN (no auth header — it's a signed URL).
    const imageResponse = await this.fetchWithTimeout(
      meta.thumb_1024_url,
      false,
    );
    if (!imageResponse.ok) {
      throw new Error(
        `Mapillary thumbnail error: ${imageResponse.status} ${imageResponse.statusText}`,
      );
    }
    const contentType =
      imageResponse.headers.get('content-type') ?? 'image/jpeg';
    const body = Buffer.from(await imageResponse.arrayBuffer());
    return { contentType, body };
  }

  private fetchWithTimeout(url: string, withAuth: boolean): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      MAPILLARY_FETCH_TIMEOUT_MS,
    );
    const headers: Record<string, string> = {};
    if (withAuth) headers.Authorization = `OAuth ${this.token}`;
    return fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  }

  private pickBest(
    rows: MapillaryImageRow[],
    bearing: number | undefined,
  ): StreetImage | null {
    // Prefer flat (non-pano) frames with an id + thumbnail — a 360° pano reads
    // poorly as a small confirmation thumb. Fall back to any usable frame.
    const usable = rows.filter((r) => r.id && r.thumb_1024_url);
    const flat = usable.filter((r) => !r.is_pano);
    const pool = flat.length > 0 ? flat : usable;
    if (pool.length === 0) return null;

    let best = pool[0]!;
    if (bearing != null && Number.isFinite(bearing)) {
      let bestDelta = Infinity;
      for (const row of pool) {
        if (row.compass_angle == null) continue;
        const delta = angularDistance(row.compass_angle, bearing);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = row;
        }
      }
    }
    return this.normalize(best);
  }

  private normalize(row: MapillaryImageRow): StreetImage | null {
    if (!row.id) return null;
    const capturedAt =
      typeof row.captured_at === 'number' && Number.isFinite(row.captured_at)
        ? new Date(row.captured_at).toISOString().slice(0, 10)
        : '';
    const creator = row.creator?.username?.trim();
    const attribution = creator
      ? `© ${creator} · Mapillary (CC BY-SA)`
      : 'Mapillary (CC BY-SA)';
    return {
      imageId: row.id,
      capturedAt,
      attribution,
      link: mapillaryImageLink(row.id),
    };
  }
}

/** Smallest angle (deg) between two compass bearings. */
function angularDistance(a: number, b: number): number {
  const diff = (((a - b) % 360) + 360) % 360;
  return diff > 180 ? 360 - diff : diff;
}
