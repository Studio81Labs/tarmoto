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
 * A point of interest stored in PostGIS for **offline** use (#745).
 *
 * Today the planner fetches POIs live from Overpass per request, which
 * can't work offline and depends on Overpass uptime. The scheduled import
 * (`PoiImportService`) mirrors a configured area into this table, upserting
 * by `(source, external_id)` so a re-import is idempotent and a partial
 * Overpass failure never wipes existing rows. Offline packs / a POI map
 * tile layer read from here. Overwritten in place on each import — no TTL.
 *
 * `source` keeps OSM and (future) Overture as separate, joinable layers so
 * the table can't be conflated into one ODbL-bound DB.
 */
@Entity('pois')
@Index('uq_pois_source_external', ['source', 'external_id'], { unique: true })
@Index('idx_pois_geom', ['geom'], { spatial: true })
@Index('idx_pois_kind', ['kind'])
// Country + category browse (#849). The GIN index on `tags` is created in the
// migration (jsonb_path_ops isn't expressible via the @Index decorator).
@Index('idx_pois_country_kind', ['address_country', 'kind'])
export class Poi {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Provider layer, e.g. `osm` (Overpass) or `overture` (gap-fill). */
  @Column({ type: 'varchar', length: 32 })
  source!: string;

  /** Stable id within the source (e.g. the OSM `node/<id>`). */
  @Column({ name: 'external_id', type: 'varchar', length: 128 })
  external_id!: string;

  /** Our POI category (restaurant, cafe, viewpoint, fuel_station, …). */
  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  website!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  phone!: string | null;

  // --- Decision-support fields captured from OSM tags (#848) ---

  /** Raw OSM `opening_hours` expression, e.g. `Mo-Su 09:00-18:00`. */
  @Column({
    name: 'opening_hours',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  opening_hours!: string | null;

  /** Street line: `addr:street` (+ `addr:housenumber`). */
  @Column({
    name: 'address_street',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  address_street!: string | null;

  @Column({
    name: 'address_city',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  address_city!: string | null;

  @Column({
    name: 'address_postcode',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  address_postcode!: string | null;

  /** Upper-case ISO 3166-1 alpha-2 country code. */
  @Column({
    name: 'address_country',
    type: 'varchar',
    length: 2,
    nullable: true,
  })
  address_country!: string | null;

  /** Normalized cuisine (restaurants / cafés). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  cuisine!: string | null;

  /** Brand, falling back to operator (fuel chains, franchises). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  brand!: string | null;

  /** Accommodation class in 1..5; null for non-accommodation POIs. */
  @Column({ type: 'smallint', nullable: true })
  stars!: number | null;

  /** Bounded raw OSM tag bag for future enrichment. */
  @Column({ type: 'jsonb', nullable: true })
  tags!: Record<string, string> | null;

  /**
   * Commercial-provider match ids (#851). Only the stable ids are persisted;
   * ratings / photos / hours are fetched on demand at view time and never
   * stored, to stay within provider ToS and keep the ODbL table clean.
   */
  @Column({
    name: 'google_place_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  google_place_id!: string | null;

  @Column({ name: 'fsq_id', type: 'varchar', length: 64, nullable: true })
  fsq_id!: string | null;

  @Column({
    name: 'enrichment_matched_at',
    type: 'timestamptz',
    nullable: true,
  })
  enrichment_matched_at!: Date | null;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  geom!: GeoJSON.Point;

  /** Batch time of the import run that last wrote this row. */
  @Column({ name: 'last_imported_at', type: 'timestamptz' })
  last_imported_at!: Date;

  /**
   * Soft-tombstone stamp (#850). Set when the bulk import finds this row
   * inside a region's bbox but absent from the latest extract (closed venue),
   * bounded by that bbox so other regions are never touched. A re-import
   * revives the row (the upsert clears this). Null = live; store read paths
   * (#849) filter `deactivated_at IS NULL`.
   */
  @Column({ name: 'deactivated_at', type: 'timestamptz', nullable: true })
  deactivated_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
