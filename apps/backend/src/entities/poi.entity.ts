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

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  geom!: GeoJSON.Point;

  /** Batch time of the import run that last wrote this row. */
  @Column({ name: 'last_imported_at', type: 'timestamptz' })
  last_imported_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
