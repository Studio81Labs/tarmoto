import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import * as GeoJSON from 'geojson';
import { UserContact } from './user-contact.entity.js';
import { Ride } from './ride.entity.js';
import { HazardReport } from './hazard-report.entity.js';
import { RoadReview } from './road-review.entity.js';
import { Trip } from './trip.entity.js';
import { CommuteRoute } from './commute-route.entity.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255, select: false })
  password_hash: string;

  @Column({ type: 'varchar', length: 100 })
  display_name: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  home_location: GeoJSON.Geometry | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  work_location: GeoJSON.Geometry | null;

  @Column({ type: 'jsonb', default: '{}' })
  preferences: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @OneToMany(() => UserContact, (c) => c.user)
  contacts: UserContact[];

  @OneToMany(() => Ride, (r) => r.user)
  rides: Ride[];

  @OneToMany(() => HazardReport, (h) => h.user)
  hazard_reports: HazardReport[];

  @OneToMany(() => RoadReview, (r) => r.user)
  road_reviews: RoadReview[];

  @OneToMany(() => Trip, (t) => t.owner)
  trips: Trip[];

  @OneToMany(() => CommuteRoute, (c) => c.user)
  commute_routes: CommuteRoute[];
}
