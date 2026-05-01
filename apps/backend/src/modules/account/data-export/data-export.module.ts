import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../../jobs/jobs.constants.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity.js';
import { UserContact } from '../../../entities/user-contact.entity.js';
import { Ride } from '../../../entities/ride.entity.js';
import { RideStats } from '../../../entities/ride-stats.entity.js';
import { Trip } from '../../../entities/trip.entity.js';
import { TripDay } from '../../../entities/trip-day.entity.js';
import { TripMember } from '../../../entities/trip-member.entity.js';
import { RoadReview } from '../../../entities/road-review.entity.js';
import { HazardReport } from '../../../entities/hazard-report.entity.js';
import { UserBadge } from '../../../entities/user-badge.entity.js';
import { ChallengeEntry } from '../../../entities/challenge-entry.entity.js';
import { CommuteRoute } from '../../../entities/commute-route.entity.js';
import { NotificationPreferencesRow } from '../../../entities/notification-preferences.entity.js';
import { DataExportRequest } from '../../../entities/data-export-request.entity.js';
import { AuthModule } from '../../auth/index.js';
import { EmailModule } from '../../email/index.js';
import { DataExportController } from './data-export.controller.js';
import { DataExportService } from './data-export.service.js';
import { DataExportProcessor } from './data-export.processor.js';
import { BundleAssembler } from './assembler/bundle-assembler.js';
import { LocalExportStorage } from './storage/local-export-storage.js';
import { EXPORT_STORAGE } from './storage/export-storage.interface.js';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    EmailModule,
    // Register the data-export BullMQ queue here so the controller can
    // inject it and enqueue at request time. The connection comes from
    // JobsModule's `BullModule.forRoot`; this `registerQueue` is a
    // queue-token registration, not a second connection.
    BullModule.registerQueue({ name: QUEUE_NAMES.DATA_EXPORT }),
    TypeOrmModule.forFeature([
      DataExportRequest,
      User,
      UserContact,
      Ride,
      RideStats,
      Trip,
      TripDay,
      TripMember,
      RoadReview,
      HazardReport,
      UserBadge,
      ChallengeEntry,
      CommuteRoute,
      NotificationPreferencesRow,
    ]),
  ],
  controllers: [DataExportController],
  providers: [
    DataExportService,
    DataExportProcessor,
    {
      provide: EXPORT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LocalExportStorage(
          config.get<string>('TARMOTO_EXPORT_STORAGE_DIR') ??
            join(tmpdir(), 'tarmoto-exports'),
        ),
    },
    {
      provide: BundleAssembler,
      inject: [
        getRepositoryToken(UserContact),
        getRepositoryToken(Ride),
        getRepositoryToken(RideStats),
        getRepositoryToken(Trip),
        getRepositoryToken(TripDay),
        getRepositoryToken(TripMember),
        getRepositoryToken(RoadReview),
        getRepositoryToken(HazardReport),
        getRepositoryToken(UserBadge),
        getRepositoryToken(ChallengeEntry),
        getRepositoryToken(CommuteRoute),
        getRepositoryToken(NotificationPreferencesRow),
      ],
      useFactory: (
        contacts: Repository<UserContact>,
        rides: Repository<Ride>,
        rideStats: Repository<RideStats>,
        trips: Repository<Trip>,
        tripDays: Repository<TripDay>,
        tripMembers: Repository<TripMember>,
        reviews: Repository<RoadReview>,
        hazards: Repository<HazardReport>,
        badges: Repository<UserBadge>,
        challenges: Repository<ChallengeEntry>,
        commute: Repository<CommuteRoute>,
        notificationPreferences: Repository<NotificationPreferencesRow>,
      ) =>
        new BundleAssembler({
          contacts,
          rides,
          rideStats,
          trips,
          tripDays,
          tripMembers,
          reviews,
          hazards,
          badges,
          challenges,
          commute,
          notificationPreferences,
        }),
    },
  ],
  // `DataExportProcessor` is consumed by the BullMQ wrapper in
  // `JobsModule` (`DataExportQueueProcessor`) which calls
  // `runner.process(...)` to assemble the bundle. Without this export
  // Nest DI fails at worker bootstrap with "can't resolve dependencies
  // of DataExportQueueProcessor". Unit tests don't catch the gap
  // because they provide manual mocks; only the running app exposes it.
  exports: [DataExportProcessor],
})
export class DataExportModule {}
