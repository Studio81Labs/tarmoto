import { Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class TilesService {
  private readonly logger = new Logger(TilesService.name);

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

    const layerQueries: string[] = [];

    if (layers === 'all' || layers === 'quality') {
      layerQueries.push(this.buildQualityLayer(bbox));
    }
    if (layers === 'all' || layers === 'surface') {
      layerQueries.push(this.buildSurfaceLayer(bbox));
    }
    if (layers === 'all' || layers === 'hazards') {
      layerQueries.push(this.buildHazardLayer(bbox));
    }

    if (layerQueries.length === 0) {
      return null;
    }

    // Concatenate all MVT layers into one tile
    // Each ST_AsMVT produces a separate layer; we concat the binary results
    const sql = `SELECT (${layerQueries.join(' || ')}) AS tile`;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.segmentRepo.query(sql);
    const rows = result as Array<{ tile: Buffer | null }>;

    if (
      !rows[0]?.tile ||
      (rows[0].tile as unknown as { length: number }).length === 0
    ) {
      return null;
    }

    return rows[0].tile;
  }

  private buildQualityLayer(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): string {
    return `(
      SELECT ST_AsMVT(q, 'quality', 4096, 'geom') FROM (
        SELECT
          rs.id,
          rs.quality_score,
          rs.confidence,
          rs.reading_count,
          ST_AsMVTGeom(
            rs.geom,
            ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326),
            4096, 64, true
          ) AS geom
        FROM road_segments rs
        WHERE rs.geom && ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
          AND rs.quality_score IS NOT NULL
      ) q
    )`;
  }

  private buildSurfaceLayer(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): string {
    return `(
      SELECT ST_AsMVT(q, 'surface', 4096, 'geom') FROM (
        SELECT
          rs.id,
          rs.surface_type,
          rs.curviness_score,
          rs.length_m,
          ST_AsMVTGeom(
            rs.geom,
            ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326),
            4096, 64, true
          ) AS geom
        FROM road_segments rs
        WHERE rs.geom && ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
      ) q
    )`;
  }

  private buildHazardLayer(bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): string {
    return `(
      SELECT ST_AsMVT(q, 'hazards', 4096, 'geom') FROM (
        SELECT
          hr.id,
          hr.hazard_type,
          hr.severity,
          hr.confirmations,
          ST_AsMVTGeom(
            hr.location,
            ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326),
            4096, 64, true
          ) AS geom
        FROM hazard_reports hr
        WHERE hr.location && ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
          AND hr.is_active = true
          AND hr.expires_at > NOW()
      ) q
    )`;
  }
}
