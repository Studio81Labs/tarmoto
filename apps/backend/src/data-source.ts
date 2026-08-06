import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity.js';
import { UserContact } from './entities/user-contact.entity.js';
import { EmailVerificationToken } from './entities/email-verification-token.entity.js';
import { PasswordResetToken } from './entities/password-reset-token.entity.js';
import { AccountDeletionLog } from './entities/account-deletion-log.entity.js';
import { CrashAlert } from './entities/crash-alert.entity.js';
import { RoadSegment } from './entities/road-segment.entity.js';
import { SurfaceReading } from './entities/surface-reading.entity.js';
import { Ride } from './entities/ride.entity.js';
import { RideSegment } from './entities/ride-segment.entity.js';
import { RideStats } from './entities/ride-stats.entity.js';
import { HazardReport } from './entities/hazard-report.entity.js';
import { HazardPhotoUpload } from './entities/hazard-photo-upload.entity.js';
import { RoadReview } from './entities/road-review.entity.js';
import { Trip } from './entities/trip.entity.js';
import { TripFolder } from './entities/trip-folder.entity.js';
import { TripMember } from './entities/trip-member.entity.js';
import { TripDay } from './entities/trip-day.entity.js';
import { TripWaypoint } from './entities/trip-waypoint.entity.js';
import { FunZone } from './entities/fun-zone.entity.js';
import { FunZoneRoad } from './entities/fun-zone-road.entity.js';
import { CommuteRoute } from './entities/commute-route.entity.js';
import { SharedRide } from './entities/shared-ride.entity.js';
import { TripShare } from './entities/trip-share.entity.js';
import { MapShare } from './entities/map-share.entity.js';
import { TripSuggestion } from './entities/trip-suggestion.entity.js';
import { TripSuggestionVote } from './entities/trip-suggestion-vote.entity.js';
import { TripMessage } from './entities/trip-message.entity.js';
import { TripInvite } from './entities/trip-invite.entity.js';
import { TripActivity } from './entities/trip-activity.entity.js';
import { DataExportRequest } from './entities/data-export-request.entity.js';
import { GroupRide } from './entities/group-ride.entity.js';
import { GroupRideMember } from './entities/group-ride-member.entity.js';
import { DeviceToken } from './entities/device-token.entity.js';
import { NotificationPreferencesRow } from './entities/notification-preferences.entity.js';
import { UserNotification } from './entities/user-notification.entity.js';
import { PrivacyPreferencesRow } from './entities/privacy-preferences.entity.js';
import { RouteCollection } from './entities/route-collection.entity.js';
import { RouteCollectionItem } from './entities/route-collection-item.entity.js';
import { RouteCollectionFollow } from './entities/route-collection-follow.entity.js';
import { WeatherAlertDispatch } from './entities/weather-alert-dispatch.entity.js';
import { Bike } from './entities/bike.entity.js';
import { RideTagEvent } from './entities/ride-tag-event.entity.js';
import { ModelEvalSample } from './entities/model-eval-sample.entity.js';
import { AdminUser } from './entities/admin-user.entity.js';
import { AdminSession } from './entities/admin-session.entity.js';
import { AdminRefreshToken } from './entities/admin-refresh-token.entity.js';
import { AdminAuditLog } from './entities/admin-audit-log.entity.js';
import { UserFeature } from './entities/user-feature.entity.js';
import { FeatureState } from './entities/feature-state.entity.js';
import { UserLimit } from './entities/user-limit.entity.js';
import { LimitState } from './entities/limit-state.entity.js';
import { AppSetting } from './entities/app-setting.entity.js';
import { EmailLog } from './entities/email-log.entity.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { ProcessedStoreNotification } from './entities/processed-store-notification.entity.js';
import { StoreBillingReconciliation } from './entities/store-billing-reconciliation.entity.js';
import { InitSchema1713000000000 } from './migrations/1713000000000-InitSchema.js';
import { AddPasswordHash1713100000000 } from './migrations/1713100000000-AddPasswordHash.js';
import { FixIsEmergencyDefault1713200000000 } from './migrations/1713200000000-FixIsEmergencyDefault.js';
import { AddUniqueActiveRide1713300000000 } from './migrations/1713300000000-AddUniqueActiveRide.js';
import { AddCommunityTables1713400000000 } from './migrations/1713400000000-AddCommunityTables.js';
import { AddChallengeTables1713500000000 } from './migrations/1713500000000-AddChallengeTables.js';
import { AddMountainPasses1713600000000 } from './migrations/1713600000000-AddMountainPasses.js';
import { AddRoadSegmentElevationProfile1713700000000 } from './migrations/1713700000000-AddRoadSegmentElevationProfile.js';
import { AddRideName1713800000000 } from './migrations/1713800000000-AddRideName.js';
import { AddUserProfileFields1713900000000 } from './migrations/1713900000000-AddUserProfileFields.js';
import { AddRoadReviewVotes1714000000000 } from './migrations/1714000000000-AddRoadReviewVotes.js';
import { AddRoadClosures1714100000000 } from './migrations/1714100000000-AddRoadClosures.js';
import { AddClosureDetourGeom1714200000000 } from './migrations/1714200000000-AddClosureDetourGeom.js';
import { AddSharedRideViewCount1714300000000 } from './migrations/1714300000000-AddSharedRideViewCount.js';
import { AddRideAvgCurviness1714400000000 } from './migrations/1714400000000-AddRideAvgCurviness.js';
import { AddSharedRideEmbedClickCount1714500000000 } from './migrations/1714500000000-AddSharedRideEmbedClickCount.js';
import { AddStripeBillingToUsers1714600000000 } from './migrations/1714600000000-AddStripeBillingToUsers.js';
import { RecencyWeightedRoadQualityAggregation1714700000000 } from './migrations/1714700000000-RecencyWeightedRoadQualityAggregation.js';
import { AddTripInviteCode1714800000000 } from './migrations/1714800000000-AddTripInviteCode.js';
import { AddTripShares1714900000000 } from './migrations/1714900000000-AddTripShares.js';
import { AddTripCollaboration1715000000000 } from './migrations/1715000000000-AddTripCollaboration.js';
import { AddTripActivity1715100000000 } from './migrations/1715100000000-AddTripActivity.js';
import { AddSurfaceReadingClientModelVersion1715200000000 } from './migrations/1715200000000-AddSurfaceReadingClientModelVersion.js';
import { AddTripShareTripLink1715250000000 } from './migrations/1715250000000-AddTripShareTripLink.js';
import { AddFunZoneClusteringSeed1715300000000 } from './migrations/1715300000000-AddFunZoneClusteringSeed.js';
import { AddTripDayGenerationColumns1715350000000 } from './migrations/1715350000000-AddTripDayGenerationColumns.js';
import { AddCrashAlerts1715400000000 } from './migrations/1715400000000-AddCrashAlerts.js';
import { AddAccountDeletion1715500000000 } from './migrations/1715500000000-AddAccountDeletion.js';
import { AddDataExportRequests1715600000000 } from './migrations/1715600000000-AddDataExportRequests.js';
import { AddEmailVerificationAndPasswordReset1715700000000 } from './migrations/1715700000000-AddEmailVerificationAndPasswordReset.js';
import { AddPasswordChangedAtAndUniqueResetToken1715800000000 } from './migrations/1715800000000-AddPasswordChangedAtAndUniqueResetToken.js';
import { AddVerificationTokenUniqueIndex1715900000000 } from './migrations/1715900000000-AddVerificationTokenUniqueIndex.js';
import { AddMapShares1716000000000 } from './migrations/1716000000000-AddMapShares.js';
import { AddGroupRides1716100000000 } from './migrations/1716100000000-AddGroupRides.js';
import { AddPushNotifications1716200000000 } from './migrations/1716200000000-AddPushNotifications.js';
import { AddRideStatsLeanDistribution1716200000000 } from './migrations/1716200000000-AddRideStatsLeanDistribution.js';
import { MigrateLegacyNotificationPreferences1716300000000 } from './migrations/1716300000000-MigrateLegacyNotificationPreferences.js';
import { AddPrivacyPreferences1716400000000 } from './migrations/1716400000000-AddPrivacyPreferences.js';
import { AddRouteCollections1716500000000 } from './migrations/1716500000000-AddRouteCollections.js';
import { AddHomeRegionIndex1716600000000 } from './migrations/1716600000000-AddHomeRegionIndex.js';
import { AddWeatherAlertDispatches1716700000000 } from './migrations/1716700000000-AddWeatherAlertDispatches.js';
import { AddRouteCollectionFollows1716800000000 } from './migrations/1716800000000-AddRouteCollectionFollows.js';
import { AddBikes1716900000000 } from './migrations/1716900000000-AddBikes.js';
import { AddRideTagEvents1717000000000 } from './migrations/1717000000000-AddRideTagEvents.js';
import { AddBikeNotesIconAndRideBikeId1717100000000 } from './migrations/1717100000000-AddBikeNotesIconAndRideBikeId.js';
import { AddSurfaceReadingClientPreprocessingVersion1717200000000 } from './migrations/1717200000000-AddSurfaceReadingClientPreprocessingVersion.js';
import { OutlierFilteredRoadQualityAggregation1717300000000 } from './migrations/1717300000000-OutlierFilteredRoadQualityAggregation.js';
import { AddDeviceCalibration1717400000000 } from './migrations/1717400000000-AddDeviceCalibration.js';
import { AddModelEvalSamples1717500000000 } from './migrations/1717500000000-AddModelEvalSamples.js';
import { AddModelEvalReconcileAttemptedAt1717600000000 } from './migrations/1717600000000-AddModelEvalReconcileAttemptedAt.js';
import { AddTripFolders1717700000000 } from './migrations/1717700000000-AddTripFolders.js';
import { AddInAppNotifications1717800000000 } from './migrations/1717800000000-AddInAppNotifications.js';
import { AddHazardReportPhotoUrl1717900000000 } from './migrations/1717900000000-AddHazardReportPhotoUrl.js';
import { AddCommuteRoutingEngineVersion1718000000000 } from './migrations/1718000000000-AddCommuteRoutingEngineVersion.js';
import { AddCommunityEngagement1718100000000 } from './migrations/1718100000000-AddCommunityEngagement.js';
import { AddTripDayStartLinked1718200000000 } from './migrations/1718200000000-AddTripDayStartLinked.js';
import { AddAdminConsoleFoundation1751000000000 } from './migrations/1751000000000-AddAdminConsoleFoundation.js';
import { AddFeatureFlags1782000000000 } from './migrations/1782000000000-AddFeatureFlags.js';
import { AddContentModeration1783000000000 } from './migrations/1783000000000-AddContentModeration.js';
import { AddNapClosureReconciliation1784000000000 } from './migrations/1784000000000-AddNapClosureReconciliation.js';
import { ClearEndedGroupRideLocations1785000000000 } from './migrations/1785000000000-ClearEndedGroupRideLocations.js';
import { AddRoadSegmentOsmIdentity1786000000000 } from './migrations/1786000000000-AddRoadSegmentOsmIdentity.js';
import { AddSurfaceFromReading1788000000000 } from './migrations/1788000000000-AddSurfaceFromReading.js';
import { AggregateClusterFunZonesByWay1789000000000 } from './migrations/1789000000000-AggregateClusterFunZonesByWay.js';
import { AddRoadSegmentWayKeyIndex1790000000000 } from './migrations/1790000000000-AddRoadSegmentWayKeyIndex.js';
import { AddRoadSegmentDeactivatedAt1791000000000 } from './migrations/1791000000000-AddRoadSegmentDeactivatedAt.js';
import { AddTripDayLegPreferences1792000000000 } from './migrations/1792000000000-AddTripDayLegPreferences.js';
import { AddTripCollaboratorRoles1793000000000 } from './migrations/1793000000000-AddTripCollaboratorRoles.js';
import { DropTripWideInviteCode1794000000000 } from './migrations/1794000000000-DropTripWideInviteCode.js';
import { AddTierFeatureEntitlements1795000000000 } from './migrations/1795000000000-AddTierFeatureEntitlements.js';
import { SwapTierNamesAddLaunchMode1796000000000 } from './migrations/1796000000000-SwapTierNamesAddLaunchMode.js';
import { DropPois1797000000000 } from './migrations/1797000000000-DropPois.js';
import { DropTripFromRouteCollections1798000000000 } from './migrations/1798000000000-DropTripFromRouteCollections.js';
import { AddEmailLog1799000000000 } from './migrations/1799000000000-AddEmailLog.js';
import { AddUserLanguage1800000000000 } from './migrations/1800000000000-AddUserLanguage.js';
import { AddEmailTemplate1810000000000 } from './migrations/1810000000000-AddEmailTemplate.js';
import { AddRoadQualitySeed1811000000000 } from './migrations/1811000000000-AddRoadQualitySeed.js';
import { DropSharedRideEmbedClickCount1812000000000 } from './migrations/1812000000000-DropSharedRideEmbedClickCount.js';
import { AddLimitEntitlements1813000000000 } from './migrations/1813000000000-AddLimitEntitlements.js';
import { AlignFeatureFlagCatalog1814000000000 } from './migrations/1814000000000-AlignFeatureFlagCatalog.js';
import { AddCommuteRoutingCacheUpdatedAt1815000000000 } from './migrations/1815000000000-AddCommuteRoutingCacheUpdatedAt.js';
import { AddChallengeContentKey1816000000000 } from './migrations/1816000000000-AddChallengeContentKey.js';
import { AddTripWaypointPoiCategory1817000000000 } from './migrations/1817000000000-AddTripWaypointPoiCategory.js';
import { SeedLaunchModeCollaboratorAndZoomLimits1818000000000 } from './migrations/1818000000000-SeedLaunchModeCollaboratorAndZoomLimits.js';
import { SeedLaunchModeAdvancedStatsAndCollabTrips1819000000000 } from './migrations/1819000000000-SeedLaunchModeAdvancedStatsAndCollabTrips.js';
import { AddHazardReportsUserCreatedIndex1820000000000 } from './migrations/1820000000000-AddHazardReportsUserCreatedIndex.js';
import { AddHazardPhotoUploads1821000000000 } from './migrations/1821000000000-AddHazardPhotoUploads.js';
import { AddIapFoundation1822000000000 } from './migrations/1822000000000-AddIapFoundation.js';
import { AddOpenAppleReconciliationDedupIndex1823000000000 } from './migrations/1823000000000-AddOpenAppleReconciliationDedupIndex.js';
import { AddSubscriptionStoreSignedDate1824000000000 } from './migrations/1824000000000-AddSubscriptionStoreSignedDate.js';
import { AddUnrecognizedProductReconciliationReason1825000000000 } from './migrations/1825000000000-AddUnrecognizedProductReconciliationReason.js';
import { AddSubscriptionLockFence1826000000000 } from './migrations/1826000000000-AddSubscriptionLockFence.js';
import { AddSubscriptionLockFenceMonotonicTrigger1827000000000 } from './migrations/1827000000000-AddSubscriptionLockFenceMonotonicTrigger.js';
import { AddSubscriptionNotifyGeneration1828000000000 } from './migrations/1828000000000-AddSubscriptionNotifyGeneration.js';
import { AddSubscriptionNotifyGenerationMonotonicTrigger1829000000000 } from './migrations/1829000000000-AddSubscriptionNotifyGenerationMonotonicTrigger.js';
import { RenameGoogleStoreTransactionId1830000000000 } from './migrations/1830000000000-RenameGoogleStoreTransactionId.js';

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
    HazardPhotoUpload,
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
    TripShare,
    MapShare,
    TripSuggestion,
    TripSuggestionVote,
    TripMessage,
    TripInvite,
    TripActivity,
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
    ProcessedStoreNotification,
    StoreBillingReconciliation,
  ],
  migrations: [
    // Listed in chronological order. Every migration in
    // src/migrations/ MUST be registered here so `pnpm db:migrate`
    // (typeorm migration:run) replays the full chain on a fresh DB.
    // The fun-zone seed (171530) calls `cluster_fun_zones()` which
    // queries `mountain_passes` (added by 171360), so the
    // prerequisite chain has to be complete or `up` will fail with
    // `relation "mountain_passes" does not exist`.
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
    AddHazardPhotoUploads1821000000000,
    AddIapFoundation1822000000000,
    AddOpenAppleReconciliationDedupIndex1823000000000,
    AddSubscriptionStoreSignedDate1824000000000,
    AddUnrecognizedProductReconciliationReason1825000000000,
    AddSubscriptionLockFence1826000000000,
    AddSubscriptionLockFenceMonotonicTrigger1827000000000,
    AddSubscriptionNotifyGeneration1828000000000,
    AddSubscriptionNotifyGenerationMonotonicTrigger1829000000000,
    RenameGoogleStoreTransactionId1830000000000,
  ],
  // Run each migration in its OWN transaction (not one wrapping the whole
  // chain), so a migration can opt out (`transaction = false`) to build an
  // index with `CREATE INDEX CONCURRENTLY` without blocking writes on a large
  // table. Forward-only migrations don't rely on cross-migration atomicity.
  migrationsTransactionMode: 'each',
  synchronize: false,
});
