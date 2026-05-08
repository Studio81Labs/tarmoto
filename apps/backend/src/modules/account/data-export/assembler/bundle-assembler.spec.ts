import { Readable } from 'node:stream';
import * as unzipper from 'unzipper';
import { BundleAssembler } from './bundle-assembler.js';
import type { User } from '../../../../entities/user.entity.js';

function makeUser(prefs: Record<string, unknown> = {}): User {
  return {
    id: 'u1',
    email: 'r@example.com',
    password_hash: 'h',
    display_name: 'R',
    phone: null,
    avatar_url: null,
    bio: null,
    home_region: null,
    home_location: null,
    work_location: null,
    preferences: prefs,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    subscription_tier: 'free',
    subscription_status: 'canceled',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as User;
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function listEntries(buf: Buffer): Promise<Map<string, string>> {
  const dir = await unzipper.Open.buffer(buf);
  const out = new Map<string, string>();
  for (const f of dir.files) {
    out.set(f.path, (await f.buffer()).toString('utf8'));
  }
  return out;
}

function emptyRepos() {
  return {
    contacts: { find: jest.fn().mockResolvedValue([]) },
    rides: { find: jest.fn().mockResolvedValue([]) },
    rideStats: { find: jest.fn().mockResolvedValue([]) },
    trips: { find: jest.fn().mockResolvedValue([]) },
    tripDays: { find: jest.fn().mockResolvedValue([]) },
    tripMembers: { find: jest.fn().mockResolvedValue([]) },
    reviews: { find: jest.fn().mockResolvedValue([]) },
    hazards: { find: jest.fn().mockResolvedValue([]) },
    badges: { find: jest.fn().mockResolvedValue([]) },
    challenges: { find: jest.fn().mockResolvedValue([]) },
    commute: { find: jest.fn().mockResolvedValue([]) },
    notificationPreferences: { findOne: jest.fn().mockResolvedValue(null) },
    privacyPreferences: { findOne: jest.fn().mockResolvedValue(null) },
    rideTagEvents: { find: jest.fn().mockResolvedValue([]) },
    bikes: { find: jest.fn().mockResolvedValue([]) },
  };
}

describe('BundleAssembler', () => {
  it('emits the documented file set when all sources are empty', async () => {
    const user = makeUser();
    const assembler = new BundleAssembler(emptyRepos());
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);

    const expected = [
      'README.txt',
      'profile.json',
      'bikes.json',
      'contacts.json',
      'preferences.json',
      'privacy.json',
      'notifications.json',
      'rides.json',
      'trips.json',
      'reviews.json',
      'hazard_reports.json',
      'badges.json',
      'challenges.json',
      'commute_routes.json',
      'ride_tag_events.json',
    ];
    for (const f of expected) expect(entries.has(f)).toBe(true);

    const profile = JSON.parse(entries.get('profile.json')!) as Record<
      string,
      unknown
    >;
    expect(profile.email).toBe('r@example.com');
    expect(profile).not.toHaveProperty('password_hash');
    expect(profile).not.toHaveProperty('stripe_customer_id');
    expect(profile).not.toHaveProperty('stripe_subscription_id');
    // preferences live in preferences.json — must not be duplicated here.
    expect(profile).not.toHaveProperty('preferences');

    expect(JSON.parse(entries.get('bikes.json')!)).toEqual([]);
    expect(JSON.parse(entries.get('contacts.json')!)).toEqual([]);
    expect(JSON.parse(entries.get('preferences.json')!)).toEqual({});
    expect(JSON.parse(entries.get('privacy.json')!)).toEqual({});
    expect(JSON.parse(entries.get('notifications.json')!)).toEqual({});

    expect(entries.get('README.txt')).toContain('Tarmoto data export');
    expect(entries.get('README.txt')).toContain('GDPR Article 15');
  });

  it('extracts privacy + notifications from their typed tables (#279)', async () => {
    const user = makeUser();
    const repos = emptyRepos();
    repos.notificationPreferences.findOne.mockResolvedValue({
      user_id: 'u1',
      email_digest: 'daily',
      marketing_emails: true,
      quiet_hours_start: 22 * 60,
      quiet_hours_end: 6 * 60,
      quiet_hours_timezone: 'Europe/Prague',
      categories: { hazard_alert: { email: false, push: true, in_app: true } },
    });
    repos.privacyPreferences.findOne.mockResolvedValue({
      user_id: 'u1',
      profile_visibility: 'private',
      default_ride_sharing: 'public',
      road_data_contribution: false,
      location_retention: '6months',
      analytics_consent: false,
      personalized_recommendations_consent: true,
    });
    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);
    expect(JSON.parse(entries.get('privacy.json')!)).toEqual({
      profile_visibility: 'private',
      default_ride_sharing: 'public',
      road_data_contribution: false,
      location_retention: '6months',
      analytics_consent: false,
      personalized_recommendations_consent: true,
    });
    expect(JSON.parse(entries.get('notifications.json')!)).toEqual({
      email_digest: 'daily',
      marketing_emails: true,
      quiet_hours_start: 22 * 60,
      quiet_hours_end: 6 * 60,
      quiet_hours_timezone: 'Europe/Prague',
      categories: {
        hazard_alert: { email: false, push: true, in_app: true },
      },
    });
  });

  it('includes rider tag events in the GDPR bundle (research issue #7)', async () => {
    // ride_tag_events is per-user data (timestamp + optional location +
    // surface label), so GDPR Article 15 requires it in the export
    // bundle alongside reviews / hazards / commute routes.
    const user = makeUser();
    const repos = emptyRepos();
    const tagRows = [
      {
        id: 'tag-1',
        ride_id: 'ride-1',
        user_id: 'u1',
        t: '1700000000000',
        lat: 49.123,
        lng: 16.789,
        label: 'cobblestone',
        created_at: new Date('2026-04-01T08:30:00Z'),
      },
    ];
    repos.rideTagEvents.find.mockResolvedValue(tagRows);

    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);

    expect(repos.rideTagEvents.find).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
    });
    // `created_at` round-trips through JSON.stringify as an ISO string —
    // compare against the same JSON projection rather than the in-memory
    // row to keep the assertion focused on what actually lands in the
    // bundle.
    expect(JSON.parse(entries.get('ride_tag_events.json')!)).toEqual(
      JSON.parse(JSON.stringify(tagRows)),
    );
    expect(entries.get('README.txt')).toContain('ride_tag_events.json');
  });

  it('writes bike rows (with rider-entered notes) to bikes.json — US-64', async () => {
    // Bikes carry rider-entered free-form `notes`, so they're personal
    // data the GDPR Article 15 export must include. Regression for the
    // bug-bot finding that bikes.json was hardcoded to `[]`.
    const user = makeUser();
    const repos = emptyRepos();
    const bikeRows = [
      {
        id: 'bike-1',
        user_id: 'u1',
        make: 'Honda',
        model: 'Africa Twin',
        year: 2024,
        is_active: true,
        photo_url: null,
        icon: 'adventure',
        notes: 'Crash bars + skid plate',
        created_at: new Date('2026-04-01T08:30:00Z'),
        updated_at: new Date('2026-04-01T08:30:00Z'),
      },
    ];
    repos.bikes.find.mockResolvedValue(bikeRows);

    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);

    expect(repos.bikes.find).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      order: { created_at: 'ASC' },
    });
    expect(JSON.parse(entries.get('bikes.json')!)).toEqual(
      JSON.parse(JSON.stringify(bikeRows)),
    );
    expect(entries.get('README.txt')).toContain('garage entries');
    expect(entries.get('README.txt')).not.toContain('empty until bike entity');
  });

  it('includes per-ride GPX files for rides with a route', async () => {
    const user = makeUser();
    const ride = {
      id: 'r1',
      user_id: 'u1',
      name: 'Loop',
      started_at: new Date('2026-04-01T08:00:00Z'),
      route_geom: {
        type: 'LineString',
        coordinates: [
          [-1, 1],
          [-2, 2],
        ],
      },
    };
    const repos = emptyRepos();
    repos.rides.find.mockResolvedValue([ride]);
    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);
    expect(entries.has('rides/r1.gpx')).toBe(true);
    expect(entries.get('rides/r1.gpx')).toContain('<gpx');
  });

  it('skips GPX for rides without route geometry', async () => {
    const user = makeUser();
    const ride = {
      id: 'r2',
      user_id: 'u1',
      name: 'manual entry',
      started_at: new Date('2026-04-01T08:00:00Z'),
      route_geom: null,
    };
    const repos = emptyRepos();
    repos.rides.find.mockResolvedValue([ride]);
    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);
    expect(entries.has('rides/r2.gpx')).toBe(false);
  });

  it('includes trip-day GPX for owned trips and member trips', async () => {
    const user = makeUser();
    const trip = { id: 't1', owner_id: 'u1', title: 'Loop' };
    const memberTrip = { id: 't2', user_id: 'u1', trip_id: 't2' };
    const day1 = {
      trip_id: 't1',
      day_number: 1,
      route_geom: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    };
    const day2 = {
      trip_id: 't2',
      day_number: 2,
      route_geom: {
        type: 'LineString',
        coordinates: [
          [2, 2],
          [3, 3],
        ],
      },
    };
    const repos = emptyRepos();
    repos.trips.find.mockResolvedValue([trip]);
    repos.tripMembers.find.mockResolvedValue([memberTrip]);
    repos.tripDays.find.mockResolvedValue([day1, day2]);

    const assembler = new BundleAssembler(repos);
    const buf = await streamToBuffer(await assembler.assemble(user));
    const entries = await listEntries(buf);
    expect(entries.has('trips/t1/day-1.gpx')).toBe(true);
    expect(entries.has('trips/t2/day-2.gpx')).toBe(true);

    const trips = JSON.parse(entries.get('trips.json')!) as {
      trips: unknown[];
      days: unknown[];
      memberships: unknown[];
    };
    expect(trips.trips).toHaveLength(1);
    expect(trips.days).toHaveLength(2);
    expect(trips.memberships).toHaveLength(1);

    // The trip-day query MUST be scoped to the user's trip ids — never
    // an unfiltered scan of the whole table.
    const tripDayCalls = repos.tripDays.find.mock.calls as unknown as Array<
      [{ where?: { trip_id?: unknown } } | undefined]
    >;
    expect(tripDayCalls[0]?.[0]?.where?.trip_id).toBeDefined();
  });

  it('skips the trip_days query entirely when the user has no trips', async () => {
    const user = makeUser();
    const repos = emptyRepos();
    const assembler = new BundleAssembler(repos);
    await streamToBuffer(await assembler.assemble(user));
    expect(repos.tripDays.find).not.toHaveBeenCalled();
  });
});
