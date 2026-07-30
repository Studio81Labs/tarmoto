import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { databaseConfig } from '../../config/database.config.js';
import { InitSchema1713000000000 } from '../../migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from '../../migrations/1713100000000-AddPasswordHash.js';
import { FixIsEmergencyDefault1713200000000 } from '../../migrations/1713200000000-FixIsEmergencyDefault.js';
import { AddUniqueActiveRide1713300000000 } from '../../migrations/1713300000000-AddUniqueActiveRide.js';
import { AddCommunityTables1713400000000 } from '../../migrations/1713400000000-AddCommunityTables.js';
import { AddChallengeTables1713500000000 } from '../../migrations/1713500000000-AddChallengeTables.js';
import { AddMountainPasses1713600000000 } from '../../migrations/1713600000000-AddMountainPasses.js';
import { AddRoadSegmentElevationProfile1713700000000 } from '../../migrations/1713700000000-AddRoadSegmentElevationProfile.js';
import { AddRideName1713800000000 } from '../../migrations/1713800000000-AddRideName.js';
import { AddUserProfileFields1713900000000 } from '../../migrations/1713900000000-AddUserProfileFields.js';
import { AddRoadReviewVotes1714000000000 } from '../../migrations/1714000000000-AddRoadReviewVotes.js';
import { AddRoadClosures1714100000000 } from '../../migrations/1714100000000-AddRoadClosures.js';
import { AddClosureDetourGeom1714200000000 } from '../../migrations/1714200000000-AddClosureDetourGeom.js';
import { AddSharedRideViewCount1714300000000 } from '../../migrations/1714300000000-AddSharedRideViewCount.js';
import { AddRideAvgCurviness1714400000000 } from '../../migrations/1714400000000-AddRideAvgCurviness.js';
import { AddSharedRideEmbedClickCount1714500000000 } from '../../migrations/1714500000000-AddSharedRideEmbedClickCount.js';
import { AddStripeBillingToUsers1714600000000 } from '../../migrations/1714600000000-AddStripeBillingToUsers.js';
import { RecencyWeightedRoadQualityAggregation1714700000000 } from '../../migrations/1714700000000-RecencyWeightedRoadQualityAggregation.js';
import { AddTripInviteCode1714800000000 } from '../../migrations/1714800000000-AddTripInviteCode.js';
import { AddTripShares1714900000000 } from '../../migrations/1714900000000-AddTripShares.js';
import { AddTripCollaboration1715000000000 } from '../../migrations/1715000000000-AddTripCollaboration.js';
import { AddTripActivity1715100000000 } from '../../migrations/1715100000000-AddTripActivity.js';
import { AddSurfaceReadingClientModelVersion1715200000000 } from '../../migrations/1715200000000-AddSurfaceReadingClientModelVersion.js';
import { AddTripShareTripLink1715250000000 } from '../../migrations/1715250000000-AddTripShareTripLink.js';
import { AddFunZoneClusteringSeed1715300000000 } from '../../migrations/1715300000000-AddFunZoneClusteringSeed.js';
import { AddTripDayGenerationColumns1715350000000 } from '../../migrations/1715350000000-AddTripDayGenerationColumns.js';
import { AddCrashAlerts1715400000000 } from '../../migrations/1715400000000-AddCrashAlerts.js';
import { AddAccountDeletion1715500000000 } from '../../migrations/1715500000000-AddAccountDeletion.js';
import { AddDataExportRequests1715600000000 } from '../../migrations/1715600000000-AddDataExportRequests.js';
import { AddEmailVerificationAndPasswordReset1715700000000 } from '../../migrations/1715700000000-AddEmailVerificationAndPasswordReset.js';
import { AddPasswordChangedAtAndUniqueResetToken1715800000000 } from '../../migrations/1715800000000-AddPasswordChangedAtAndUniqueResetToken.js';
import { AddVerificationTokenUniqueIndex1715900000000 } from '../../migrations/1715900000000-AddVerificationTokenUniqueIndex.js';
import { AddMapShares1716000000000 } from '../../migrations/1716000000000-AddMapShares.js';
import { AddGroupRides1716100000000 } from '../../migrations/1716100000000-AddGroupRides.js';
import { AddPushNotifications1716200000000 } from '../../migrations/1716200000000-AddPushNotifications.js';
import { AddRideStatsLeanDistribution1716200000000 } from '../../migrations/1716200000000-AddRideStatsLeanDistribution.js';
import { MigrateLegacyNotificationPreferences1716300000000 } from '../../migrations/1716300000000-MigrateLegacyNotificationPreferences.js';
import { AddPrivacyPreferences1716400000000 } from '../../migrations/1716400000000-AddPrivacyPreferences.js';
import { AddRouteCollections1716500000000 } from '../../migrations/1716500000000-AddRouteCollections.js';
import { AddHomeRegionIndex1716600000000 } from '../../migrations/1716600000000-AddHomeRegionIndex.js';
import { AddWeatherAlertDispatches1716700000000 } from '../../migrations/1716700000000-AddWeatherAlertDispatches.js';
import { AddRouteCollectionFollows1716800000000 } from '../../migrations/1716800000000-AddRouteCollectionFollows.js';
import { AddBikes1716900000000 } from '../../migrations/1716900000000-AddBikes.js';
import { AddRideTagEvents1717000000000 } from '../../migrations/1717000000000-AddRideTagEvents.js';
import { AddBikeNotesIconAndRideBikeId1717100000000 } from '../../migrations/1717100000000-AddBikeNotesIconAndRideBikeId.js';
import { AddSurfaceReadingClientPreprocessingVersion1717200000000 } from '../../migrations/1717200000000-AddSurfaceReadingClientPreprocessingVersion.js';
import { OutlierFilteredRoadQualityAggregation1717300000000 } from '../../migrations/1717300000000-OutlierFilteredRoadQualityAggregation.js';
import { AddDeviceCalibration1717400000000 } from '../../migrations/1717400000000-AddDeviceCalibration.js';
import { AddModelEvalSamples1717500000000 } from '../../migrations/1717500000000-AddModelEvalSamples.js';
import { AddModelEvalReconcileAttemptedAt1717600000000 } from '../../migrations/1717600000000-AddModelEvalReconcileAttemptedAt.js';
import { AddTripFolders1717700000000 } from '../../migrations/1717700000000-AddTripFolders.js';
import { AddInAppNotifications1717800000000 } from '../../migrations/1717800000000-AddInAppNotifications.js';
import { AddHazardReportPhotoUrl1717900000000 } from '../../migrations/1717900000000-AddHazardReportPhotoUrl.js';
import { AddCommuteRoutingEngineVersion1718000000000 } from '../../migrations/1718000000000-AddCommuteRoutingEngineVersion.js';
import { AddCommunityEngagement1718100000000 } from '../../migrations/1718100000000-AddCommunityEngagement.js';
import { AddTripDayStartLinked1718200000000 } from '../../migrations/1718200000000-AddTripDayStartLinked.js';
import { AddAdminConsoleFoundation1751000000000 } from '../../migrations/1751000000000-AddAdminConsoleFoundation.js';
import { AddFeatureFlags1782000000000 } from '../../migrations/1782000000000-AddFeatureFlags.js';
import { AddContentModeration1783000000000 } from '../../migrations/1783000000000-AddContentModeration.js';
import { AddNapClosureReconciliation1784000000000 } from '../../migrations/1784000000000-AddNapClosureReconciliation.js';
import { ClearEndedGroupRideLocations1785000000000 } from '../../migrations/1785000000000-ClearEndedGroupRideLocations.js';
import { AddRoadSegmentOsmIdentity1786000000000 } from '../../migrations/1786000000000-AddRoadSegmentOsmIdentity.js';
import { AddSurfaceFromReading1788000000000 } from '../../migrations/1788000000000-AddSurfaceFromReading.js';
import { AggregateClusterFunZonesByWay1789000000000 } from '../../migrations/1789000000000-AggregateClusterFunZonesByWay.js';
import { AddRoadSegmentWayKeyIndex1790000000000 } from '../../migrations/1790000000000-AddRoadSegmentWayKeyIndex.js';
import { AddRoadSegmentDeactivatedAt1791000000000 } from '../../migrations/1791000000000-AddRoadSegmentDeactivatedAt.js';
import { AddTripDayLegPreferences1792000000000 } from '../../migrations/1792000000000-AddTripDayLegPreferences.js';
import { AddTripCollaboratorRoles1793000000000 } from '../../migrations/1793000000000-AddTripCollaboratorRoles.js';
import { DropTripWideInviteCode1794000000000 } from '../../migrations/1794000000000-DropTripWideInviteCode.js';
import { AddTierFeatureEntitlements1795000000000 } from '../../migrations/1795000000000-AddTierFeatureEntitlements.js';
import { SwapTierNamesAddLaunchMode1796000000000 } from '../../migrations/1796000000000-SwapTierNamesAddLaunchMode.js';
import { DropPois1797000000000 } from '../../migrations/1797000000000-DropPois.js';
import { DropTripFromRouteCollections1798000000000 } from '../../migrations/1798000000000-DropTripFromRouteCollections.js';
import { AddEmailLog1799000000000 } from '../../migrations/1799000000000-AddEmailLog.js';
import { AddUserLanguage1800000000000 } from '../../migrations/1800000000000-AddUserLanguage.js';
import { AddEmailTemplate1810000000000 } from '../../migrations/1810000000000-AddEmailTemplate.js';
import { AddRoadQualitySeed1811000000000 } from '../../migrations/1811000000000-AddRoadQualitySeed.js';
import { DropSharedRideEmbedClickCount1812000000000 } from '../../migrations/1812000000000-DropSharedRideEmbedClickCount.js';
import { AddLimitEntitlements1813000000000 } from '../../migrations/1813000000000-AddLimitEntitlements.js';
import { AlignFeatureFlagCatalog1814000000000 } from '../../migrations/1814000000000-AlignFeatureFlagCatalog.js';
import { AddCommuteRoutingCacheUpdatedAt1815000000000 } from '../../migrations/1815000000000-AddCommuteRoutingCacheUpdatedAt.js';
import { AddChallengeContentKey1816000000000 } from '../../migrations/1816000000000-AddChallengeContentKey.js';
import { AddTripWaypointPoiCategory1817000000000 } from '../../migrations/1817000000000-AddTripWaypointPoiCategory.js';
import { SeedLaunchModeCollaboratorAndZoomLimits1818000000000 } from '../../migrations/1818000000000-SeedLaunchModeCollaboratorAndZoomLimits.js';
import { SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000 } from '../../migrations/1819000000000-SeedLaunchModeAdvancedStatsAndCollabTrips.js';
import { AddHazardReportsUserCreatedIndex1820000000000 } from '../../migrations/1820000000000-AddHazardReportsUserCreatedIndex.js';
import {
  User,
  UserContact,
  EmailVerificationToken,
  PasswordResetToken,
  AccountDeletionLog,
  CrashAlert,
  RoadSegment,
  SurfaceReading,
  Ride,
  RideSegment,
  RideStats,
  HazardReport,
  RoadReview,
  Trip,
  TripFolder,
  TripMember,
  TripDay,
  TripWaypoint,
  FunZone,
  FunZoneRoad,
  CommuteRoute,
  SharedRide,
  RideLike,
  TripShare,
  MapShare,
  TripSuggestion,
  TripSuggestionVote,
  TripMessage,
  TripActivity,
  TripInvite,
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
  DataExportRequest,
  GroupRide,
  GroupRideMember,
  DeviceToken,
  NotificationPreferencesRow,
  UserNotification,
  PrivacyPreferencesRow,
  RouteCollection,
  RouteCollectionItem,
  RouteCollectionFollow,
  WeatherAlertDispatch,
  Bike,
  RideTagEvent,
  ModelEvalSample,
  AdminUser,
  AdminSession,
  AdminRefreshToken,
  AdminAuditLog,
  UserFeature,
  FeatureState,
  UserLimit,
  LimitState,
  AppSetting,
  EmailLog,
  EmailTemplate,
} from '../../entities/index.js';

const entities = [
  User,
  UserContact,
  EmailVerificationToken,
  PasswordResetToken,
  AccountDeletionLog,
  CrashAlert,
  RoadSegment,
  SurfaceReading,
  Ride,
  RideSegment,
  RideStats,
  HazardReport,
  RoadReview,
  Trip,
  TripFolder,
  TripMember,
  TripDay,
  TripWaypoint,
  FunZone,
  FunZoneRoad,
  CommuteRoute,
  SharedRide,
  RideLike,
  TripShare,
  MapShare,
  TripSuggestion,
  TripSuggestionVote,
  TripMessage,
  TripActivity,
  TripInvite,
  UserFollow,
  UserBadge,
  Challenge,
  ChallengeEntry,
  MountainPass,
  RoadReviewVote,
  RoadClosure,
  DataExportRequest,
  GroupRide,
  GroupRideMember,
  DeviceToken,
  NotificationPreferencesRow,
  UserNotification,
  PrivacyPreferencesRow,
  RouteCollection,
  RouteCollectionItem,
  RouteCollectionFollow,
  WeatherAlertDispatch,
  Bike,
  RideTagEvent,
  ModelEvalSample,
  AdminUser,
  AdminSession,
  AdminRefreshToken,
  AdminAuditLog,
  UserFeature,
  FeatureState,
  UserLimit,
  LimitState,
  AppSetting,
  EmailLog,
  EmailTemplate,
];

@Module({
  imports: [
    ConfigModule.forFeature(databaseConfig),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isOpenApiExport = process.env['OPENAPI_EXPORT'] === 'true';
        const host = config.get<string>('database.host');
        const port = config.get<number>('database.port');
        const database = config.get<string>('database.database');
        const username = config.get<string>('database.username');
        const password = config.get<string>('database.password');
        return {
          type: 'postgres',
          ...(host !== undefined ? { host } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(database !== undefined ? { database } : {}),
          ...(username !== undefined ? { username } : {}),
          ...(password !== undefined ? { password } : {}),
          entities,
          migrations: [
            // Listed in chronological order. Every migration in
            // `src/migrations/` MUST be registered here so the runtime
            // `migrationsRun: true` path replays the full chain on a
            // fresh DB. Keep in sync with `data-source.ts` — drift
            // between the two would silently leave runtime DBs short
            // of schema changes that the CLI applies.
            InitSchema1713000000000,
            AddPasswordHash1713100000000,
            FixIsEmergencyDefault1713200000000,
            AddUniqueActiveRide1713300000000,
            AddCommunityTables1713400000000,
            AddChallengeTables1713500000000,
            AddMountainPasses1713600000000,
            AddRoadSegmentElevationProfile1713700000000,
            AddRideName1713800000000,
            AddUserProfileFields1713900000000,
            AddRoadReviewVotes1714000000000,
            AddRoadClosures1714100000000,
            AddClosureDetourGeom1714200000000,
            AddSharedRideViewCount1714300000000,
            AddRideAvgCurviness1714400000000,
            AddSharedRideEmbedClickCount1714500000000,
            AddStripeBillingToUsers1714600000000,
            RecencyWeightedRoadQualityAggregation1714700000000,
            AddTripInviteCode1714800000000,
            AddTripShares1714900000000,
            AddTripCollaboration1715000000000,
            AddTripActivity1715100000000,
            AddSurfaceReadingClientModelVersion1715200000000,
            AddTripShareTripLink1715250000000,
            AddFunZoneClusteringSeed1715300000000,
            AddTripDayGenerationColumns1715350000000,
            AddCrashAlerts1715400000000,
            AddAccountDeletion1715500000000,
            AddDataExportRequests1715600000000,
            AddEmailVerificationAndPasswordReset1715700000000,
            AddPasswordChangedAtAndUniqueResetToken1715800000000,
            AddVerificationTokenUniqueIndex1715900000000,
            AddMapShares1716000000000,
            AddGroupRides1716100000000,
            AddPushNotifications1716200000000,
            AddRideStatsLeanDistribution1716200000000,
            MigrateLegacyNotificationPreferences1716300000000,
            AddPrivacyPreferences1716400000000,
            AddRouteCollections1716500000000,
            AddHomeRegionIndex1716600000000,
            AddWeatherAlertDispatches1716700000000,
            AddRouteCollectionFollows1716800000000,
            AddBikes1716900000000,
            AddRideTagEvents1717000000000,
            AddBikeNotesIconAndRideBikeId1717100000000,
            AddSurfaceReadingClientPreprocessingVersion1717200000000,
            OutlierFilteredRoadQualityAggregation1717300000000,
            AddDeviceCalibration1717400000000,
            AddModelEvalSamples1717500000000,
            AddModelEvalReconcileAttemptedAt1717600000000,
            AddTripFolders1717700000000,
            AddInAppNotifications1717800000000,
            AddHazardReportPhotoUrl1717900000000,
            AddCommuteRoutingEngineVersion1718000000000,
            AddCommunityEngagement1718100000000,
            AddTripDayStartLinked1718200000000,
            AddAdminConsoleFoundation1751000000000,
            AddFeatureFlags1782000000000,
            AddContentModeration1783000000000,
            AddNapClosureReconciliation1784000000000,
            ClearEndedGroupRideLocations1785000000000,
            AddRoadSegmentOsmIdentity1786000000000,
            AddSurfaceFromReading1788000000000,
            AggregateClusterFunZonesByWay1789000000000,
            AddRoadSegmentWayKeyIndex1790000000000,
            AddRoadSegmentDeactivatedAt1791000000000,
            AddTripDayLegPreferences1792000000000,
            AddTripCollaboratorRoles1793000000000,
            DropTripWideInviteCode1794000000000,
            AddTierFeatureEntitlements1795000000000,
            SwapTierNamesAddLaunchMode1796000000000,
            DropPois1797000000000,
            DropTripFromRouteCollections1798000000000,
            AddEmailLog1799000000000,
            AddUserLanguage1800000000000,
            AddEmailTemplate1810000000000,
            AddRoadQualitySeed1811000000000,
            DropSharedRideEmbedClickCount1812000000000,
            AddLimitEntitlements1813000000000,
            AlignFeatureFlagCatalog1814000000000,
            AddCommuteRoutingCacheUpdatedAt1815000000000,
            AddChallengeContentKey1816000000000,
            AddTripWaypointPoiCategory1817000000000,
            SeedLaunchModeCollaboratorAndZoomLimits1818000000000,
            SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000,
            AddHazardReportsUserCreatedIndex1820000000000,
          ],
          // During OpenAPI spec export we don't need a real DB connection.
          // Disable retries and migrations so bootstrap completes without a DB.
          migrationsRun: !isOpenApiExport,
          synchronize: false,
          retryAttempts: isOpenApiExport ? 0 : 10,
          logging:
            config.get('NODE_ENV') === 'development'
              ? ['error', 'warn', 'migration']
              : ['error'],
        };
      },
    }),
  ],
})
export class DatabaseModule {}
