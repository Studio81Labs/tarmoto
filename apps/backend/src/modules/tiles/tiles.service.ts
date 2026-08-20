import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveLimit } from '@tarmoto/shared';
import { RoadSegment } from '../../entities/road-segment.entity.js';
import { FeatureResolver } from '../features/feature-resolver.service.js';

/**
 * Whether the ANONYMOUS leg of the `road_quality_max_zoom` tile clamp is
 * enforced (#1108). Default OFF — deliberately, because when it shipped every
 * live consumer of this endpoint fetched tiles WITHOUT any identity (MapLibre
 * sources on both clients, and the mobile offline-pack downloader, which
 * caches quality tiles up to z16), so a paying rider's overlay at z13–18 and a
 * scraper were the same anonymous request.
 *
 * That client channel now exists (#1279): the live map sources on both clients
 * append a scoped `tile_token`, and the offline downloader sends the rider's
 * bearer. Identity-carrying requests are ALWAYS enforced against their
 * resolved cap, so this flag now governs only genuinely anonymous traffic —
 * signed-out visitors, scrapers, and clients too old to carry a credential.
 *
 * It stays OFF by default because flipping it is an operator decision with a
 * blast radius: since migration 1839 cleared the launch seeds, the free cap
 * resolves to `12` for real, so the flip immediately clamps every anonymous
 * requester (see `docs/reference/feature-flags.md`). Read per request so tests
 * (and an operator restart) see the current value.
 */
function anonQualityZoomClampEnabled(): boolean {
  return (
    (process.env.TARMOTO_TILES_ANON_QUALITY_ZOOM_CLAMP_ENABLED ?? 'false')
      .trim()
      .toLowerCase() === 'true'
  );
}

/**
 * Convert tile coordinates (z/x/y) to a bounding box in EPSG:4326.
 * Standard "Slippy map" tile numbering.
 */
function tileToBBox(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { west, south, east, north };
}

interface LayerQuery {
  sql: string;
  params: number[];
}

@Injectable()
export class TilesService {
  constructor(
    @InjectRepository(RoadSegment)
    private readonly segmentRepo: Repository<RoadSegment>,
    private readonly featureResolver: FeatureResolver,
  ) {}

  /**
   * Generate a Mapbox Vector Tile (MVT) from PostGIS for the given z/x/y.
   * Returns a Buffer containing the protobuf-encoded tile.
   *
   * `userId` is the OPTIONALLY-authenticated requester (`null` = anonymous;
   * the controller resolves it from a bearer via `OptionalAuthGuard` or from
   * the scoped `tile_token` query credential). It exists for the
   * `road_quality_max_zoom` clamp (#1108): the QUALITY layer is withheld
   * beyond the requester's resolved zoom cap — see
   * {@link qualityAllowedAtZoom}. The surface and hazard layers are not
   * quality data and are never clamped. Defaulting to `null` means a caller
   * that forgets the argument gets the ANONYMOUS (most-clamped) treatment,
   * never an accidental entitlement widening.
   */
  async getTile(
    z: number,
    x: number,
    y: number,
    layers: string = 'all',
    userId: string | null = null,
  ): Promise<Buffer | null> {
    const bbox = tileToBBox(z, x, y);
    const bboxParams = [bbox.west, bbox.south, bbox.east, bbox.north];

    const layerQueries: LayerQuery[] = [];

    if (
      (layers === 'all' || layers === 'quality') &&
      (await this.qualityAllowedAtZoom(z, userId))
    ) {
      layerQueries.push(this.buildQualityLayer());
    }
    if (layers === 'all' || layers === 'surface') {
      layerQueries.push(this.buildSurfaceLayer());
    }
    if (layers === 'all' || layers === 'hazards') {
      layerQueries.push(this.buildHazardLayer());
    }

    if (layerQueries.length === 0) {
      return null;
    }

    // Each layer query uses $1-$4 for the bbox, so we rewrite placeholders
    // to use unique parameter indices when concatenating multiple layers.
    // Use regex with word boundary (?!\d) to avoid $1 matching inside $10/$11/$12.
    let paramIndex = 1;
    const allParams: number[] = [];
    const rewrittenLayers: string[] = [];

    for (const layer of layerQueries) {
      let sql = layer.sql;
      for (let i = layer.params.length; i >= 1; i--) {
        sql = sql.replaceAll(
          new RegExp(`\\$${i}(?!\\d)`, 'g'),
          `$${paramIndex + i - 1}`,
        );
      }
      rewrittenLayers.push(sql);
      allParams.push(...bboxParams);
      paramIndex += layer.params.length;
    }

    const sql = `SELECT (${rewrittenLayers.join(' || ')}) AS tile`;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.segmentRepo.query(sql, allParams);
    const rows = result as Array<{ tile: Buffer | null }>;

    if (
      !rows[0]?.tile ||
      (rows[0].tile as unknown as { length: number }).length === 0
    ) {
      return null;
    }

    return rows[0].tile;
  }

  /**
   * Whether the QUALITY layer may be served at tile zoom `z` to this
   * requester (#1108). `road_quality_max_zoom` (registry: free `12`,
   * pro/premium `null` = unlimited) fed only the CLIENT-side layer `maxzoom`
   * until now — `limit-snapshot.dto.ts` resolves it into the snapshot, but a
   * crafted client could fetch quality tiles at any depth. This is the
   * server-side backstop: tiles at `z <= cap` are exactly what a capped
   * client legitimately renders (its layer maxzoom hides the overlay from
   * map zoom `cap` upward, so it never requests deeper quality tiles);
   * strictly above the cap the quality layer is withheld.
   *
   *  - Authenticated: `resolveLimitsForUser` — the full per-user resolution
   *    (tier, per-user override, global override; `null` = unlimited).
   *    Always enforced, and since #1279 this is the live boundary for both
   *    clients: three indexed reads per identified quality tile, resolved
   *    fresh so a downgrade takes effect on the very next tile rather than
   *    at the next credential rotation.
   *  - Anonymous: the FREE-tier resolution from the same global override
   *    map the public `/config/limits` endpoint serves (exactly how a
   *    signed-out client resolves its own clamp) — but only once
   *    {@link anonQualityZoomClampEnabled} is flipped; see its doc for why
   *    the anonymous leg must ship dark. Env off = no resolver read at all,
   *    keeping today's zero-DB-cost path for the 600/min anonymous bursts.
   */
  private async qualityAllowedAtZoom(
    z: number,
    userId: string | null,
  ): Promise<boolean> {
    if (userId !== null) {
      const limits = await this.featureResolver.resolveLimitsForUser(userId);
      const cap = limits.road_quality_max_zoom;
      return cap === null || z <= cap;
    }
    if (!anonQualityZoomClampEnabled()) return true;
    const overrides = await this.featureResolver.getGlobalLimitOverrides();
    const cap = resolveLimit(
      'road_quality_max_zoom',
      'free',
      undefined,
      overrides['road_quality_max_zoom'],
    );
    return cap === null || z <= cap;
  }

  private buildQualityLayer(): LayerQuery {
    // The client filters segments by surface_type and curviness_score on top of
    // quality_score — so we include all three in the quality layer rather than
    // forcing the map to render a second source just to apply filters.
    return {
      sql: `(
        SELECT ST_AsMVT(q, 'quality', 4096, 'geom') FROM (
          SELECT
            rs.id,
            rs.quality_score,
            rs.confidence,
            rs.reading_count,
            rs.surface_type,
            rs.curviness_score,
            ST_AsMVTGeom(
              rs.geom,
              ST_MakeEnvelope($1, $2, $3, $4, 4326),
              4096, 64, true
            ) AS geom
          FROM road_segments rs
          WHERE rs.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND rs.quality_score IS NOT NULL
            AND rs.deactivated_at IS NULL
        ) q
      )`,
      params: [0, 0, 0, 0], // placeholder, replaced by bboxParams
    };
  }

  private buildSurfaceLayer(): LayerQuery {
    return {
      sql: `(
        SELECT ST_AsMVT(q, 'surface', 4096, 'geom') FROM (
          SELECT
            rs.id,
            rs.surface_type,
            rs.curviness_score,
            rs.length_m,
            ST_AsMVTGeom(
              rs.geom,
              ST_MakeEnvelope($1, $2, $3, $4, 4326),
              4096, 64, true
            ) AS geom
          FROM road_segments rs
          WHERE rs.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND rs.deactivated_at IS NULL
        ) q
      )`,
      params: [0, 0, 0, 0],
    };
  }

  private buildHazardLayer(): LayerQuery {
    return {
      sql: `(
        SELECT ST_AsMVT(q, 'hazards', 4096, 'geom') FROM (
          SELECT
            hr.id,
            hr.hazard_type,
            hr.severity,
            hr.confirmations,
            ST_AsMVTGeom(
              hr.location,
              ST_MakeEnvelope($1, $2, $3, $4, 4326),
              4096, 64, true
            ) AS geom
          FROM hazard_reports hr
          WHERE hr.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND hr.is_active = true
            AND hr.expires_at > NOW()
            AND hr.moderation_status = 'visible'
        ) q
      )`,
      params: [0, 0, 0, 0],
    };
  }
}
