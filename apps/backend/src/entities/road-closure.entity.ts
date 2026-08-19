import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import * as GeoJSON from 'geojson';

/**
 * A road closure or construction zone affecting a road stretch over a
 * date range (US-40). Operator-entered to start; future sources (OSM,
 * official feeds) populate the same table with a different `source`.
 *
 * `ends_at` is nullable — a null end date means "in effect indefinitely
 * / until further notice", which is the common case for long-running
 * seasonal closures.
 *
 * The reconciliation columns (`external_id`, `last_seen_at`, `is_active`,
 * `first_seen_at`, `validity_status`) and the decoding columns
 * (nullable `geom`, `needs_location_decoding`, `raw_location_ref`) exist
 * so a feed poller (#743) can mirror an external source like the Czech
 * NAP: upsert by `(source, external_id)`, stamp `last_seen_at` on every
 * snapshot a row appears in, set `is_active = false` when it drops out
 * (keeping history for audit), and store Alert-C (TMC) / OpenLR linear
 * closures that arrive with no coordinates (`geom = null`,
 * `needs_location_decoding = true`) instead of dropping them. Operator
 * rows leave all of these at their defaults: no `external_id`, never
 * touched by the reconcile pass, always carrying geometry.
 */
export type RoadClosureReason =
  'closure' | 'roadworks' | 'seasonal' | 'weather' | 'event' | 'other';

export type RoadClosureSeverity = 'advisory' | 'partial' | 'full';

export type RoadClosureSource = 'operator' | 'osm' | 'official';

@Entity('road_closures')
@Index('idx_road_closures_geom', ['geom'], { spatial: true })
@Index('idx_road_closures_country', ['country_code'])
@Index('idx_road_closures_window', ['starts_at', 'ends_at'])
@Index('idx_road_closures_source_active', ['source', 'is_active'])
export class RoadClosure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'varchar', length: 20 })
  reason!: RoadClosureReason;

  @Column({ type: 'varchar', length: 20 })
  severity!: RoadClosureSeverity;

  /**
   * Nullable since #743 — Alert-C (TMC) / OpenLR linear closures from an
   * external feed arrive without coordinates and are stored with
   * `geom = null` + `needs_location_decoding = true` until decoded.
   * Operator-entered closures always carry geometry. Read paths exclude
   * `geom IS NULL` rows so the planner map / router never see them.
   */
  @Column({
    type: 'geometry',
    spatialFeatureType: 'LineString',
    srid: 4326,
    nullable: true,
  })
  geom!: GeoJSON.LineString | null;

  /**
   * Optional detour polyline surfaced when the planner map shows a
   * roadworks closure. Only meaningful when `reason = 'roadworks'` — the
   * service enforces that on write. Null for every other closure type
   * and for roadworks where no detour has been captured.
   */
  @Column({
    type: 'geometry',
    spatialFeatureType: 'LineString',
    srid: 4326,
    nullable: true,
  })
  detour_geom!: GeoJSON.LineString | null;

  @Column({ type: 'varchar', length: 2 })
  country_code!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  region!: string | null;

  @Column({ type: 'timestamptz' })
  starts_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ends_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'operator' })
  source!: RoadClosureSource;

  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  /**
   * Stable id of the situation in its source feed (e.g. a DATEX II
   * `situationRecord` id). Unique together with `source` via a partial
   * index. `null` for operator-entered rows, which are never reconciled.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  external_id!: string | null;

  /**
   * Batch time stamped on every snapshot this row appears in. The
   * reconcile pass deactivates rows of the same `source` whose
   * `last_seen_at` is older than the current batch. `null` for operator
   * rows.
   */
  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at!: Date | null;

  /** When the situation first entered the feed. `null` for operator rows. */
  @Column({ type: 'timestamptz', nullable: true })
  first_seen_at!: Date | null;

  /**
   * Whether the closure is currently present + valid. The reconcile pass
   * sets `false` when a feed row drops out of the snapshot or its window
   * ends; the row is retained for audit. Operator rows stay `true`. Read
   * paths treat a closure as live only when `is_active` is `true`.
   */
  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  /** Raw DATEX validity status passthrough, kept for debugging. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  validity_status!: string | null;

  /**
   * `true` when the feed row carried only Alert-C (TMC) / OpenLR location
   * codes and no resolvable coordinates, so `geom` is `null`. These rows
   * are stored (not dropped) and excluded from every public read until a
   * decoder resolves them.
   */
  @Column({ type: 'boolean', default: false })
  needs_location_decoding!: boolean;

  /** Raw location reference captured for later Alert-C/OpenLR decoding. */
  @Column({ type: 'jsonb', nullable: true })
  raw_location_ref!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
