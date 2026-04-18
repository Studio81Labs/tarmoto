import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import * as GeoJSON from 'geojson';

/**
 * A high-altitude road pass with seasonal availability (US-11).
 *
 * `typical_open_month` / `typical_close_month` describe the usual annual
 * window when the pass is rideable (1 = January, 12 = December, both
 * inclusive). The window may wrap across the new year for southern-
 * hemisphere passes — `PassesService.statusFor()` handles both cases.
 *
 * `override_status` lets an operator pin the live status (e.g. "closed
 * for repairs in July") without editing the typical window. When
 * non-null it wins over the month-based derivation.
 */
export type MountainPassOverrideStatus = 'open' | 'closed' | 'unknown';

@Entity('mountain_passes')
@Index('idx_mountain_passes_location', ['location'], { spatial: true })
@Index('idx_mountain_passes_country', ['country_code'])
export class MountainPass {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 2 })
  country_code: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  region: string | null;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326 })
  location: GeoJSON.Point;

  @Column({ type: 'int' })
  elevation_m: number;

  @Column({ type: 'smallint' })
  typical_open_month: number;

  @Column({ type: 'smallint' })
  typical_close_month: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  override_status: MountainPassOverrideStatus | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_updated: Date;
}
