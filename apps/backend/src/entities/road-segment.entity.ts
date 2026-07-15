import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Check,
  Index,
  OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { SurfaceReading } from './surface-reading.entity.js';
import { HazardReport } from './hazard-report.entity.js';
import { RoadReview } from './road-review.entity.js';

@Entity('road_segments')
@Index('idx_road_segments_geom', ['geom'], { spatial: true })
@Index('idx_road_segments_quality', ['quality_score'])
@Index('idx_road_segments_curviness', ['curviness_score'])
// Partial on live rows (#835): a tombstoned row must not own its OSM key, so a
// returning key inserts fresh and a carry-over onto a formerly-tombstoned key
// doesn't hit a unique violation.
@Index('uq_road_segments_osm_identity', ['osm_way_id', 'segment_index'], {
  unique: true,
  where: 'deactivated_at IS NULL',
})
// OSM identity is all-or-nothing: a half-populated `(osm_way_id, NULL)`
// would slip past the unique index (NULLs don't conflict) and let a
// re-import upsert insert a duplicate instead of preserving the UUID (#751).
@Check(
  'chk_road_segments_osm_identity',
  '("osm_way_id" IS NULL) = ("segment_index" IS NULL)',
)
export class RoadSegment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'geometry', spatialFeatureType: 'LineString', srid: 4326 })
  geom!: GeoJSON.Geometry;

  @Column({ type: 'float' })
  length_m!: number;

  /**
   * Stable identity for weekly/monthly OSM re-imports (#751): the source
   * OSM way id plus the segment's ordinal within that way (a way is split
   * into ~100 m segments). A re-importer upserts on
   * `(osm_way_id, segment_index)` so a segment's UUID — and every
   * `surface_readings` / `road_reviews` / `hazard_reports` /
   * `fun_zone_road` row that references it — survives the re-import.
   *
   * Nullable because rows seeded before the first OSM import (and demo
   * data) carry no OSM identity; a plain unique index treats those NULLs
   * as distinct so they coexist. TypeORM returns `bigint` as a string.
   */
  @Column({ type: 'bigint', nullable: true })
  osm_way_id!: string | null;

  @Column({ type: 'int', nullable: true })
  segment_index!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  road_name!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  road_number!: string | null;

  @Column({ type: 'float', default: 0 })
  curviness_score!: number;

  @Column({ type: 'float', nullable: true })
  quality_score!: number | null;

  /**
   * OSM-derived quality prior [1,5] (design 2026-07-15). Refreshed from tags on
   * every import; blended with rider data into `quality_score` by
   * `update_road_quality_for_segment`. Never owned away by riders.
   */
  @Column({ type: 'float', nullable: true })
  osm_quality_seed!: number | null;

  /** Which OSM signal produced `osm_quality_seed` (provenance for labeling). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  quality_source!: string | null;

  @Column({ type: 'varchar', length: 30, default: 'unknown' })
  surface_type!: string;

  /**
   * Whether `surface_type` is rider-derived (#796). Set true (and sticky) by
   * `update_road_quality_for_segment` once a non-null `surface_readings.surface_type`
   * exists for the segment. Durable — unlike the raw readings it is derived from,
   * it survives the `location_retention` sweep, so the OSM importer can safely
   * refresh the OSM `surface` seed only while this is false without ever
   * clobbering a crowd-classified surface.
   */
  @Column({ type: 'boolean', default: false })
  surface_from_reading!: boolean;

  @Column({ type: 'int', default: 0 })
  reading_count!: number;

  @Column({ type: 'int', default: 0 })
  confidence!: number;

  /**
   * Issue #495 — number of readings the most recent aggregation run
   * dropped as >2σ outliers before computing `quality_score` and
   * `confidence`. 0 when fewer than 3 readings exist (filter is
   * skipped) or when no reading exceeded the 2σ threshold.
   * Persisted so dispute investigations and data-quality dashboards
   * can see whether a low rider count on a segment is the raw count
   * or an artifact of aggressive filtering, without replaying
   * `surface_readings`.
   */
  @Column({ type: 'int', default: 0 })
  last_filtered_count!: number;

  @Column({ type: 'float', nullable: true })
  elevation_min!: number | null;

  @Column({ type: 'float', nullable: true })
  elevation_max!: number | null;

  @Column({ type: 'float', array: true, nullable: true })
  elevation_profile!: number[] | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_updated!: Date;

  /**
   * When set, this segment is no longer part of the current OSM snapshot (its way
   * was removed, or split/merged away — see ADR-0006) but is retained rather than
   * deleted: `surface_readings` / `road_reviews` / `hazard_reports` /
   * `fun_zone_roads` FK to it, and its crowdsourced history is preserved. Active
   * read paths filter on `deactivated_at IS NULL`; NULL = live (the default for
   * every crowd-sourced and current row). Maintained by the OSM importer's
   * split/merge reconciliation (#835).
   */
  @Column({ type: 'timestamptz', nullable: true })
  deactivated_at!: Date | null;

  @OneToMany(() => SurfaceReading, (r) => r.road_segment)
  surface_readings!: SurfaceReading[];

  @OneToMany(() => HazardReport, (h) => h.road_segment)
  hazard_reports!: HazardReport[];

  @OneToMany(() => RoadReview, (r) => r.road_segment)
  road_reviews!: RoadReview[];
}
