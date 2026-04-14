import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../entities/road-segment.entity.js';

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
  ) {}

  /**
   * Generate a Mapbox Vector Tile (MVT) from PostGIS for the given z/x/y.
   * Returns a Buffer containing the protobuf-encoded tile.
   */
  async getTile(
    z: number,
    x: number,
    y: number,
    layers: string = 'all',
  ): Promise<Buffer | null> {
    const bbox = tileToBBox(z, x, y);
    const bboxParams = [bbox.west, bbox.south, bbox.east, bbox.north];

    const layerQueries: LayerQuery[] = [];

    if (layers === 'all' || layers === 'quality') {
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

  private buildQualityLayer(): LayerQuery {
    return {
      sql: `(
        SELECT ST_AsMVT(q, 'quality', 4096, 'geom') FROM (
          SELECT
            rs.id,
            rs.quality_score,
            rs.confidence,
            rs.reading_count,
            ST_AsMVTGeom(
              rs.geom,
              ST_MakeEnvelope($1, $2, $3, $4, 4326),
              4096, 64, true
            ) AS geom
          FROM road_segments rs
          WHERE rs.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND rs.quality_score IS NOT NULL
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
        ) q
      )`,
      params: [0, 0, 0, 0],
    };
  }
}
