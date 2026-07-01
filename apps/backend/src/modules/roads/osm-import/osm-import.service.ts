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

/** Geometry columns derived from `geom`, nulled when the geometry changes so a
 *  downstream elevation-enrichment pass recomputes them (a NULL profile/min/max
 *  is a state every consumer already handles). */
const GEOM_DERIVED_COLUMNS = [
  'elevation_min',
  'elevation_max',
  'elevation_profile',
];

/**
 * True iff the stored geometry differs from the incoming one at the vertex
 * level. `ST_OrderingEquals` compares exact coordinate sequence (bbox-gated
 * internally), so — unlike the `=`/`IS DISTINCT FROM` operator, which only
 * compares bounding boxes — a same-bbox reshape is still detected.
 */
const GEOM_CHANGED = `NOT ST_OrderingEquals("${TABLE}"."geom", EXCLUDED."geom")`;

/**
 * The raw `ON CONFLICT … DO UPDATE …` clause. Built once.
 *
 * `surface_type`: INSERT-only. It seeds a brand-new segment from the OSM
 * `surface` tag, but is NEVER overwritten on conflict, so a rider-classified
 * surface is preserved. It is deliberately not refreshed for still-unclassified
 * segments either: doing that safely needs a *durable* provenance flag, because
 * the raw `surface_readings` a segment was classified from are deleted once they
 * age past a user's `location_retention` (while the aggregate `surface_type`
 * persists), so any check against raw readings would flip and clobber the
 * rider value after the sweep. Tracked in #796.
 *
 * `elevation_*`: nulled whenever the geometry changes, since they were computed
 * from the previous geometry and would otherwise be served stale by
 * `RoadsService.findById` / fun-zone detail and skew elevation math.
 *
 * `WHERE …`: skips no-op rows. A weekly snapshot re-sends mostly-identical rows;
 * without this every conflict emits an unconditional `DO UPDATE`, churning row
 * locks + WAL on a national import. The row updates only if the geometry or an
 * OSM attribute actually changed.
 */
function buildOnConflictClause(): string {
  const set = [
    ...OSM_REFRESH_COLUMNS.map((c) => `"${c}" = EXCLUDED."${c}"`),
    ...GEOM_DERIVED_COLUMNS.map(
      (c) =>
        `"${c}" = CASE WHEN ${GEOM_CHANGED} THEN NULL ELSE "${TABLE}"."${c}" END`,
    ),
  ];
  const changed = [
    GEOM_CHANGED,
    ...OSM_REFRESH_COLUMNS.filter((c) => c !== 'geom').map(
      (c) => `"${TABLE}"."${c}" IS DISTINCT FROM EXCLUDED."${c}"`,
    ),
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
 * `reading_count`, the `id`, and the `surface_type` seed untouched on update
 * (the #751 stable-identity guarantee; surface refresh is deferred to #796),
 * nulls the geometry-derived `elevation_*` columns when the geometry changes,
 * and skips rows whose values did not change.
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
    // the DO UPDATE must (a) omit the crowdsourced + surface_type columns, (b)
    // null `elevation_*` conditionally on geometry change, and (c) skip no-op
    // rows — none of which the column-array API can express. `.values()` still
    // builds the INSERT (incl. PostGIS geometry binding); only the tail is raw.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(RoadSegment)
      .values(rows)
      .onConflict(ROAD_SEGMENT_ON_CONFLICT)
      .execute();
  }
}
