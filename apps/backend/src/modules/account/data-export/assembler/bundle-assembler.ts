import type * as GeoJSON from 'geojson';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import { In, type Repository } from 'typeorm';
import type { User } from '../../../../entities/user.entity.js';
import type { UserContact } from '../../../../entities/user-contact.entity.js';
import type { Ride } from '../../../../entities/ride.entity.js';
import type { RideStats } from '../../../../entities/ride-stats.entity.js';
import type { Trip } from '../../../../entities/trip.entity.js';
import type { TripDay } from '../../../../entities/trip-day.entity.js';
import type { TripMember } from '../../../../entities/trip-member.entity.js';
import type { RoadReview } from '../../../../entities/road-review.entity.js';
import type { HazardReport } from '../../../../entities/hazard-report.entity.js';
import type { UserBadge } from '../../../../entities/user-badge.entity.js';
import type { ChallengeEntry } from '../../../../entities/challenge-entry.entity.js';
import type { CommuteRoute } from '../../../../entities/commute-route.entity.js';
import type { NotificationPreferencesRow } from '../../../../entities/notification-preferences.entity.js';
import type { PrivacyPreferencesRow } from '../../../../entities/privacy-preferences.entity.js';
import { sanitizeUserForExport } from './sanitizers.js';
import { rideToGpx, tripDayToGpx } from './gpx.js';

export interface BundleRepos {
  contacts: Pick<Repository<UserContact>, 'find'>;
  rides: Pick<Repository<Ride>, 'find'>;
  rideStats: Pick<Repository<RideStats>, 'find'>;
  trips: Pick<Repository<Trip>, 'find'>;
  tripDays: Pick<Repository<TripDay>, 'find'>;
  tripMembers: Pick<Repository<TripMember>, 'find'>;
  reviews: Pick<Repository<RoadReview>, 'find'>;
  hazards: Pick<Repository<HazardReport>, 'find'>;
  badges: Pick<Repository<UserBadge>, 'find'>;
  challenges: Pick<Repository<ChallengeEntry>, 'find'>;
  commute: Pick<Repository<CommuteRoute>, 'find'>;
  notificationPreferences: Pick<
    Repository<NotificationPreferencesRow>,
    'findOne'
  >;
  privacyPreferences: Pick<Repository<PrivacyPreferencesRow>, 'findOne'>;
}

export class BundleAssembler {
  constructor(private readonly repos: BundleRepos) {}

  async assemble(user: User): Promise<Readable> {
    const userId = user.id;

    const [
      contacts,
      rides,
      trips,
      tripMembers,
      reviews,
      hazards,
      badges,
      challenges,
      commute,
      notificationRow,
      privacyRow,
    ] = await Promise.all([
      this.repos.contacts.find({ where: { user_id: userId } }),
      this.repos.rides.find({
        where: { user_id: userId },
        order: { started_at: 'DESC' },
      }),
      this.repos.trips.find({ where: { owner_id: userId } }),
      this.repos.tripMembers.find({ where: { user_id: userId } }),
      this.repos.reviews.find({ where: { user_id: userId } }),
      this.repos.hazards.find({ where: { user_id: userId } }),
      this.repos.badges.find({ where: { user_id: userId } }),
      this.repos.challenges.find({ where: { user_id: userId } }),
      this.repos.commute.find({ where: { user_id: userId } }),
      this.repos.notificationPreferences.findOne({
        where: { user_id: userId },
      }),
      this.repos.privacyPreferences.findOne({ where: { user_id: userId } }),
    ]);

    const allTripIds = Array.from(
      new Set<string>([
        ...trips.map((t) => t.id),
        ...tripMembers.map((m) => m.trip_id),
      ]),
    );

    const rideIds = rides.map((r) => r.id);
    const [visibleDays, rideStats] = await Promise.all([
      allTripIds.length
        ? this.repos.tripDays.find({ where: { trip_id: In(allTripIds) } })
        : Promise.resolve([]),
      rideIds.length
        ? this.repos.rideStats.find({ where: { ride_id: In(rideIds) } })
        : Promise.resolve([]),
    ]);

    const sanitizedProfile = sanitizeUserForExport(user);
    const generatedAt = new Date().toISOString();

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.append(buildReadme(generatedAt), { name: 'README.txt' });
    archive.append(json(sanitizedProfile), { name: 'profile.json' });
    archive.append(json([]), { name: 'bikes.json' });
    archive.append(json(contacts), { name: 'contacts.json' });
    archive.append(json(user.preferences ?? {}), {
      name: 'preferences.json',
    });
    archive.append(json(extractPrivacy(privacyRow)), {
      name: 'privacy.json',
    });
    archive.append(json(extractNotifications(notificationRow)), {
      name: 'notifications.json',
    });
    archive.append(json({ rides, stats: rideStats }), { name: 'rides.json' });
    archive.append(
      json({ trips, days: visibleDays, memberships: tripMembers }),
      { name: 'trips.json' },
    );
    archive.append(json(reviews), { name: 'reviews.json' });
    archive.append(json(hazards), { name: 'hazard_reports.json' });
    archive.append(json(badges), { name: 'badges.json' });
    archive.append(json(challenges), { name: 'challenges.json' });
    archive.append(json(commute), { name: 'commute_routes.json' });

    for (const r of rides) {
      const gpx = rideToGpx({
        name: r.name ?? `ride-${r.id}`,
        startedAt: r.started_at,
        route:
          (r as { route_geom?: GeoJSON.LineString | null }).route_geom ?? null,
      });
      if (gpx) archive.append(gpx, { name: `rides/${r.id}.gpx` });
    }

    for (const day of visibleDays) {
      const trip = trips.find((t) => t.id === day.trip_id);
      const gpx = tripDayToGpx({
        tripTitle: trip?.title ?? `trip-${day.trip_id}`,
        dayNumber: (day as { day_number: number }).day_number,
        route:
          (day as { route_geom?: GeoJSON.LineString | null }).route_geom ??
          null,
      });
      if (gpx) {
        archive.append(gpx, {
          name: `trips/${day.trip_id}/day-${(day as { day_number: number }).day_number}.gpx`,
        });
      }
    }

    // archiver emits errors on the stream itself for most failure modes,
    // but the promise returned by finalize() can also reject (zlib/IO).
    // Re-emit so the downstream pipeline observes the failure instead of
    // leaving an unhandled rejection that could crash the worker.
    archive.finalize().catch((err: unknown) => {
      archive.emit(
        'error',
        err instanceof Error ? err : new Error(String(err)),
      );
    });
    return archive;
  }
}

function json(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function buildReadme(generatedAt: string): string {
  return [
    'Tarmoto data export',
    `Generated: ${generatedAt}`,
    '',
    'This bundle contains the personal data Tarmoto holds about your account,',
    'in fulfillment of GDPR Article 15.',
    '',
    'Files included:',
    '  profile.json         - account profile (password hash and Stripe IDs removed)',
    '  bikes.json           - garage entries (empty until bike entity ships)',
    '  contacts.json        - emergency contacts',
    '  preferences.json     - user preferences blob',
    '  privacy.json         - privacy preferences (typed table; empty when never edited)',
    '  notifications.json   - notification preferences (typed table; empty when never edited)',
    '  rides.json           - ride metadata + per-ride stats',
    '  rides/<id>.gpx       - GPX track per ride with a route',
    '  trips.json           - trip metadata + days + your memberships',
    '  trips/<id>/day-N.gpx - GPX track per planned trip day',
    '  reviews.json         - your road reviews (photo URLs included; binaries not bundled)',
    '  hazard_reports.json  - hazards you submitted',
    '  badges.json          - badges you earned',
    '  challenges.json      - challenge entries',
    '  commute_routes.json  - your saved commute routes',
    '',
    'Anonymized road quality contributions are NOT included because they no',
    'longer reference your account after anonymization.',
    '',
    'The download link for this bundle expires 7 days after generation.',
    '',
  ].join('\n');
}

function extractPrivacy(
  row: PrivacyPreferencesRow | null | undefined,
): Record<string, unknown> {
  // Returns the raw typed-table row so the export reflects exactly what
  // the enforcement gates read (#279). Empty object when the user has
  // never saved preferences — defaults live in `@tarmoto/shared` and
  // are applied at gate time, so re-materializing them here would be
  // misleading (the rider hasn't actually opted into anything yet).
  if (!row) return {};
  return {
    profile_visibility: row.profile_visibility,
    default_ride_sharing: row.default_ride_sharing,
    road_data_contribution: row.road_data_contribution,
    location_retention: row.location_retention,
    analytics_consent: row.analytics_consent,
    personalized_recommendations_consent:
      row.personalized_recommendations_consent,
  };
}

function extractNotifications(
  row: NotificationPreferencesRow | null | undefined,
): Record<string, unknown> {
  // Returns the raw typed-table row so the export reflects exactly what
  // the dispatchers gate on. Empty object when the user has never saved
  // preferences — defaults live in `@tarmoto/shared` and are applied at
  // dispatch time, so re-materializing them here would be misleading.
  if (!row) return {};
  return {
    email_digest: row.email_digest,
    marketing_emails: row.marketing_emails,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    quiet_hours_timezone: row.quiet_hours_timezone,
    categories: row.categories ?? {},
  };
}
