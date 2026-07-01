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

/** Target table — referenced bare in the raw conflict clause to read the
 *  existing row (Postgres `DO UPDATE` refers to the target row by table name,
 *  `EXCLUDED` to the proposed one). */
const TABLE = 'road_segments';

/** Conflict target: the stable `(osm_way_id, segment_index)` identity (#751). */
const CONFLICT_COLUMNS = ['osm_way_id', 'segment_index'];

/**
 * OSM-owned columns refreshed verbatim from the incoming snapshot on every
 * conflict. Excludes the crowdsourced/identity columns (`quality_score`,
 * `confidence`, `reading_count`, `id`) — the importer never carries them in its
 * rows, so they are untouched on update and defaulted on insert (the #751
 * stable-identity guarantee). `surface_type` is handled separately below.
 */
const OSM_REFRESH_COLUMNS = [
  'geom',
  'length_m',
  'curviness_score',
  'road_name',
  'road_number',
];

/**
 * The raw `ON CONFLICT … DO UPDATE …` clause. Built once.
 *
 * `surface_type`: refreshed from the OSM seed ONLY while a segment has no sensor
 * readings (`reading_count = 0`). Per ADR-0005 the OSM seed tracks the OSM cycle
 * but a rider-classified surface (`reading_count > 0`, owned by
 * `update_road_quality_for_segment`) is authoritative and must survive re-import
 * — hence the `CASE`, not a blanket refresh or a blanket exclude.
 *
 * `WHERE …`: skips no-op rows. A weekly snapshot re-sends mostly-identical rows;
 * without this every conflict would emit an unconditional `DO UPDATE`, churning
 * row locks + WAL on a national import. The row is updated only if an OSM column
 * actually changed, or an unread segment's surface seed changed.
 */
function buildOnConflictClause(): string {
  const set = [
    ...OSM_REFRESH_COLUMNS.map((c) => `"${c}" = EXCLUDED."${c}"`),
    `"surface_type" = CASE WHEN "${TABLE}"."reading_count" = 0 ` +
      `THEN EXCLUDED."surface_type" ELSE "${TABLE}"."surface_type" END`,
  ];
  const changed = [
    ...OSM_REFRESH_COLUMNS.map(
      (c) => `"${TABLE}"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`,
    ),
    `("${TABLE}"."reading_count" = 0 AND ` +
      `"${TABLE}"."surface_type" IS DISTINCT FROM EXCLUDED."surface_type")`,
  ];
  const target = CONFLICT_COLUMNS.map((c) => `"${c}"`).join(', ');
  return `( ${target} ) DO UPDATE SET ${set.join(', ')} WHERE ${changed.join(' OR ')}`;
}

/** Pre-built so it isn't reconstructed per chunk. */
export const ROAD_SEGMENT_ON_CONFLICT = buildOnConflictClause();

export interface OsmImportResult {
  upserted: number;
}

/**
 * Persists the OSM road network into `road_segments` (#781). Streams rows from
 * an `OsmWaySource` (the PBF parser — separate slice) through the pure
 * transform and bulk-upserts them ON CONFLICT `(osm_way_id, segment_index)`.
 *
 * The conflict clause (see {@link ROAD_SEGMENT_ON_CONFLICT}) refreshes only the
 * OSM-owned columns, leaves the crowdsourced `quality_score` / `confidence` /
 * `reading_count` and the `id` untouched (the #751 stable-identity guarantee),
 * refreshes the `surface_type` seed only while a segment has no readings, and
 * skips rows whose OSM values did not change.
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
    // Raw conflict clause (not `repo.upsert` / the `orUpdate` array form) because
    // the DO UPDATE must (a) omit the crowdsourced columns, (b) refresh
    // `surface_type` conditionally per `reading_count`, and (c) skip no-op rows —
    // none of which the column-array API can express. `.values()` still builds
    // the INSERT (incl. PostGIS geometry binding); only the conflict tail is raw.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(RoadSegment)
      .values(rows)
      .onConflict(ROAD_SEGMENT_ON_CONFLICT)
      .execute();
  }
}
