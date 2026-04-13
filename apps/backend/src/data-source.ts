import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity.js';
import { UserContact } from './entities/user-contact.entity.js';
import { RoadSegment } from './entities/road-segment.entity.js';
import { SurfaceReading } from './entities/surface-reading.entity.js';
import { Ride } from './entities/ride.entity.js';
import { RideSegment } from './entities/ride-segment.entity.js';
import { RideStats } from './entities/ride-stats.entity.js';
import { HazardReport } from './entities/hazard-report.entity.js';
import { RoadReview } from './entities/road-review.entity.js';
import { Trip } from './entities/trip.entity.js';
import { TripMember } from './entities/trip-member.entity.js';
import { TripDay } from './entities/trip-day.entity.js';
import { TripWaypoint } from './entities/trip-waypoint.entity.js';
import { FunZone } from './entities/fun-zone.entity.js';
import { FunZoneRoad } from './entities/fun-zone-road.entity.js';
import { CommuteRoute } from './entities/commute-route.entity.js';
import { InitSchema1713000000000 } from './migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from './migrations/1713100000000-AddPasswordHash.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.TARMOTO_DATABASE_HOST || 'localhost',
  port: parseInt(process.env.TARMOTO_DATABASE_PORT || '5432', 10),
  database: process.env.TARMOTO_DATABASE_NAME || 'tarmoto',
  username: process.env.TARMOTO_DATABASE_USER || 'tarmoto',
  password: process.env.TARMOTO_DATABASE_PASSWORD || 'tarmoto',
  entities: [
    User,
    UserContact,
    RoadSegment,
    SurfaceReading,
    Ride,
    RideSegment,
    RideStats,
    HazardReport,
    RoadReview,
    Trip,
    TripMember,
    TripDay,
    TripWaypoint,
    FunZone,
    FunZoneRoad,
    CommuteRoute,
  ],
  migrations: [InitSchema1713000000000, AddPasswordHash1713100000000],
  synchronize: false,
});
