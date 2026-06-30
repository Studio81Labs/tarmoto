import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadSegment } from '../../../entities/road-segment.entity.js';
import {
  type OsmWaySource,
  type RoadSegmentRow,
  buildSegmentRows,
} from './segment-rows.js';

/** Rows per bulk upsert — keeps each statement well under PG's 65,535-param
 *  limit (each row binds ~8 columns). */
const UPSERT_CHUNK = 500;

export interface OsmImportResult {
  upserted: number;
}

/**
 * Persists the OSM road network into `road_segments` (#781). Streams rows from
 * an `OsmWaySource` (the PBF parser — separate slice) through the pure
 * transform and bulk-upserts them ON CONFLICT `(osm_way_id, segment_index)`.
 *
 * Because each row carries ONLY the OSM-derived columns (geometry, name,
 * number, surface seed, curviness) — NOT the crowdsourced `quality_score` /
 * `confidence` / `reading_count` — TypeORM's `DO UPDATE SET` touches only those
 * columns, so a re-import preserves a segment's **UUID**, its dependent FKs,
 * and the crowdsourced quality (the #751 stable-identity guarantee). New rows
 * get the crowdsourced columns' defaults.
 *
 * No delete pass here: stale rows (ways removed from OSM, or split/merged) are
 * the separate split/merge slice's concern — this overwrites in place.
 */
@Injectable()
export class OsmImportService {
  private readonly logger = new Logger(OsmImportService.name);

  constructor(
    @InjectRepository(RoadSegment)
    private readonly repo: Repository<RoadSegment>,
  ) {}

  async importFrom(source: OsmWaySource): Promise<OsmImportResult> {
    let batch: RoadSegmentRow[] = [];
    let upserted = 0;

    for await (const row of buildSegmentRows(source)) {
      batch.push(row);
      if (batch.length >= UPSERT_CHUNK) {
        await this.flush(batch);
        upserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.flush(batch);
      upserted += batch.length;
    }

    this.logger.log(`OSM import: upserted ${upserted} road segments`);
    return { upserted };
  }

  private async flush(rows: RoadSegmentRow[]): Promise<void> {
    await this.repo.upsert(rows, {
      conflictPaths: ['osm_way_id', 'segment_index'],
    });
  }
}
