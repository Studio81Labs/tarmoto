import type * as GeoJSON from 'geojson';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import type { Repository } from 'typeorm';
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
}

export class BundleAssembler {
  constructor(private readonly repos: BundleRepos) {}

  async assemble(user: User): Promise<Readable> {
    const userId = user.id;

    const [
      contacts,
      rides,
      trips,
      tripDays,
      tripMembers,
      reviews,
      hazards,
      badges,
      challenges,
      commute,
    ] = await Promise.all([
      this.repos.contacts.find({ where: { user_id: userId } }),
      this.repos.rides.find({
        where: { user_id: userId },
        order: { started_at: 'DESC' },
      }),
      this.repos.trips.find({ where: { owner_id: userId } }),
      this.repos.tripDays.find({}),
      this.repos.tripMembers.find({ where: { user_id: userId } }),
      this.repos.reviews.find({ where: { user_id: userId } }),
      this.repos.hazards.find({ where: { user_id: userId } }),
      this.repos.badges.find({ where: { user_id: userId } }),
      this.repos.challenges.find({ where: { user_id: userId } }),
      this.repos.commute.find({ where: { user_id: userId } }),
    ]);

    const ownedTripIds = new Set(trips.map((t) => t.id));
    const memberTripIds = new Set(tripMembers.map((m) => m.trip_id));
    const allTripIds = new Set<string>([...ownedTripIds, ...memberTripIds]);
    const visibleDays = tripDays.filter((d) => allTripIds.has(d.trip_id));

    const rideIds = rides.map((r) => r.id);
    const rideStats = rideIds.length
      ? await this.repos.rideStats.find({
          where: rideIds.map((id) => ({ ride_id: id })),
        })
      : [];

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
    archive.append(json(extractPrivacy(user)), { name: 'privacy.json' });
    archive.append(json(extractNotifications(user)), {
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

    void archive.finalize();
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
    '  privacy.json         - privacy settings derived from preferences',
    '  notifications.json   - notification settings derived from preferences',
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

function extractPrivacy(user: User): Record<string, unknown> {
  const prefs = user.preferences ?? {};
  return (prefs.privacy as Record<string, unknown>) ?? {};
}

function extractNotifications(user: User): Record<string, unknown> {
  const prefs = user.preferences ?? {};
  return (prefs.notifications as Record<string, unknown>) ?? {};
}
