export { User } from './user.entity.js';
export { UserContact } from './user-contact.entity.js';
export { EmailVerificationToken } from './email-verification-token.entity.js';
export { PasswordResetToken } from './password-reset-token.entity.js';
export { AccountDeletionLog } from './account-deletion-log.entity.js';
export type { AccountDeletionEvent } from './account-deletion-log.entity.js';
export { CrashAlert } from './crash-alert.entity.js';
export type {
  CrashAlertSeverity,
  CrashAlertContactStatus,
  CrashAlertContactChannel,
  CrashAlertContactResult,
} from './crash-alert.entity.js';
export { RoadSegment } from './road-segment.entity.js';
export { SurfaceReading } from './surface-reading.entity.js';
export { Ride } from './ride.entity.js';
export { RideSegment } from './ride-segment.entity.js';
export { RideStats } from './ride-stats.entity.js';
export { HazardReport } from './hazard-report.entity.js';
export { HazardPhotoUpload } from './hazard-photo-upload.entity.js';
export { RoadReview } from './road-review.entity.js';
export { RoadReviewVote } from './road-review-vote.entity.js';
export { Trip } from './trip.entity.js';
export { TripFolder } from './trip-folder.entity.js';
export { TripMember } from './trip-member.entity.js';
export { TripDay } from './trip-day.entity.js';
export { TripWaypoint } from './trip-waypoint.entity.js';
export { FunZone } from './fun-zone.entity.js';
export { FunZoneRoad } from './fun-zone-road.entity.js';
export { CommuteRoute } from './commute-route.entity.js';
export { SharedRide } from './shared-ride.entity.js';
export { RideLike } from './ride-like.entity.js';
export { TripShare } from './trip-share.entity.js';
export { MapShare } from './map-share.entity.js';
export { TripSuggestion } from './trip-suggestion.entity.js';
export { TripSuggestionVote } from './trip-suggestion-vote.entity.js';
export { TripMessage } from './trip-message.entity.js';
export { TripInvite } from './trip-invite.entity.js';
export { TripActivity } from './trip-activity.entity.js';
export { UserFollow } from './user-follow.entity.js';
export { UserBadge } from './user-badge.entity.js';
export { Challenge } from './challenge.entity.js';
export { ChallengeEntry } from './challenge-entry.entity.js';
export { MountainPass } from './mountain-pass.entity.js';
export { RoadClosure } from './road-closure.entity.js';
// NOTE: `Poi` is intentionally NOT re-exported here. It belongs to the POI DB
// (`@tarmoto/poi-db`), a separate read-only connection wired by
// `PoiDatabaseModule` — not this app-DB entity barrel. Re-exporting it would
// fold it into any `Object.values(AllEntities)` app-DB DataSource (e.g. the
// demo-seed e2e), registering an entity for a table that isn't in that DB.
export { DataExportRequest } from './data-export-request.entity.js';
export type { DataExportStatus } from './data-export-request.entity.js';
export { GroupRide } from './group-ride.entity.js';
export { GroupRideMember } from './group-ride-member.entity.js';
export { DeviceToken } from './device-token.entity.js';
export { NotificationPreferencesRow } from './notification-preferences.entity.js';
export { UserNotification } from './user-notification.entity.js';
export { PrivacyPreferencesRow } from './privacy-preferences.entity.js';
export { RouteCollection } from './route-collection.entity.js';
export type { RouteCollectionVisibility } from './route-collection.entity.js';
export { RouteCollectionItem } from './route-collection-item.entity.js';
export { RouteCollectionFollow } from './route-collection-follow.entity.js';
export { WeatherAlertDispatch } from './weather-alert-dispatch.entity.js';
export { Bike } from './bike.entity.js';
export { RideTagEvent } from './ride-tag-event.entity.js';
export { ModelEvalSample } from './model-eval-sample.entity.js';
export { AdminUser } from './admin-user.entity.js';
export type { AdminRole, AdminUserStatus } from './admin-user.entity.js';
export { AdminSession } from './admin-session.entity.js';
export { AdminRefreshToken } from './admin-refresh-token.entity.js';
export { AdminAuditLog } from './admin-audit-log.entity.js';
export { UserFeature } from './user-feature.entity.js';
export { FeatureState } from './feature-state.entity.js';
export { UserLimit } from './user-limit.entity.js';
export { LimitState } from './limit-state.entity.js';
export { AppSetting } from './app-setting.entity.js';
export { EmailLog } from './email-log.entity.js';
export { EmailTemplate } from './email-template.entity.js';
export { ProcessedStoreNotification } from './processed-store-notification.entity.js';
export { StoreBillingReconciliation } from './store-billing-reconciliation.entity.js';
export { StoreSubscription } from './store-subscription.entity.js';
export { StoreDeletionObligation } from './store-deletion-obligation.entity.js';
