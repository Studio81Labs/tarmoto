/**
 * Demo persona catalog. Pure data — no DB access — so it can be unit
 * tested and reasoned about independently of the seeder. Each persona is
 * tuned to land in a distinct app state (fresh signup, weekend rider,
 * power user, trip planner, community contributor) so QA and demos can
 * log in as the right account to exercise a given screen.
 *
 * Activity volumes are expressed as plain counts; `demo-data-builders`
 * turns them into concrete rides/roads/etc., and `BadgesService` then
 * awards badges from the seeded rows, so a persona's badges always match
 * the production badge rules rather than being hand-asserted here.
 */
import type { SubscriptionTier } from '@tarmoto/shared';

export interface DemoBike {
  make: string;
  model: string;
  year: number;
}

export interface DemoPersona {
  /** Login email. Canonical lower-case `*@tarmoto.app`. */
  email: string;
  display_name: string;
  bio: string;
  subscription_tier: SubscriptionTier;
  home_region: string;
  /** Home base — rides/hazards/reviews are generated around this point. */
  home: { lat: number; lng: number };
  /** Account age; the seeder backdates `created_at` by this many days. */
  joinedDaysAgo: number;
  bikes: DemoBike[];
  /** Number of completed rides. */
  rideCount: number;
  /** Central distance (km) per ride; the builder jitters around it. */
  baseRideKm: number;
  /** Distinct demo roads linked via ride_segments (drives roads_discovered). */
  roadsRiddenCount: number;
  hazardCount: number;
  reviewCount: number;
  sharedRideCount: number;
  /** Multi-day trips owned by this persona. */
  tripCount: number;
  /** Emails of other personas this persona follows. */
  follows: string[];
  /**
   * When set, this persona's rides and trips come from real recorded Calimoto
   * GPX (`real-demo-rides.data.ts`) instead of synthetic random-walk geometry,
   * so the companion shows real routes. `rideCount`/`tripCount` must equal the
   * data-module lengths (asserted in `demo-personas.spec.ts`); the other counts
   * (hazards/reviews/roads/…) still seed synthetically around `home`.
   */
  useRealGpx?: boolean;
}

/**
 * Each demo account's password is simply its own email — nothing extra to
 * remember, just type the email in both fields to log into the
 * companion/mobile app. Every persona email comfortably clears the
 * register policy (8..72 chars), which `demo-personas.spec.ts` asserts.
 */
export function demoPasswordFor(persona: Pick<DemoPersona, 'email'>): string {
  return persona.email;
}

/**
 * Marker stored on every seeded user's `preferences` JSON and matched on
 * cleanup. Email-based cleanup is the primary path; this is a belt-and-
 * suspenders flag the seeder also writes.
 */
export const DEMO_PREFERENCE_FLAG = 'is_demo';

export const DEMO_PERSONAS: DemoPersona[] = [
  {
    email: 'newbie@tarmoto.app',
    display_name: 'Nina Newbie',
    bio: 'Just unboxed my first bike and this app. Where do I even start?',
    subscription_tier: 'free',
    home_region: 'Brno, CZ',
    home: { lat: 49.1951, lng: 16.6068 },
    joinedDaysAgo: 2,
    bikes: [{ make: 'Honda', model: 'CB500F', year: 2024 }],
    // Fresh account: one short shakedown ride, no badges yet.
    rideCount: 1,
    baseRideKm: 14,
    roadsRiddenCount: 2,
    hazardCount: 0,
    reviewCount: 0,
    sharedRideCount: 0,
    tripCount: 0,
    follows: ['road.hunter@tarmoto.app', 'weekend.warrior@tarmoto.app'],
  },
  {
    email: 'weekend.warrior@tarmoto.app',
    display_name: 'Will Weekend',
    bio: 'Office Monday–Friday, Moravian backroads every Saturday.',
    subscription_tier: 'pro',
    home_region: 'Brno, CZ',
    home: { lat: 49.2102, lng: 16.5993 },
    joinedDaysAgo: 220,
    bikes: [{ make: 'Yamaha', model: 'MT-07', year: 2022 }],
    // Mid-tier: silver distance, a clutch of bronze badges.
    rideCount: 28,
    baseRideKm: 46,
    roadsRiddenCount: 40,
    hazardCount: 3,
    reviewCount: 6,
    sharedRideCount: 4,
    tripCount: 1,
    follows: ['road.hunter@tarmoto.app', 'community.scout@tarmoto.app'],
  },
  {
    email: 'road.hunter@tarmoto.app',
    display_name: 'Roman Hunter',
    bio: 'If it has switchbacks, I have already ridden it twice.',
    subscription_tier: 'premium',
    home_region: 'Beskydy, CZ',
    home: { lat: 49.5045, lng: 18.3216 },
    joinedDaysAgo: 1500,
    bikes: [
      { make: 'KTM', model: '1290 Super Adventure S', year: 2023 },
      { make: 'Aprilia', model: 'Tuono V4', year: 2021 },
      { make: 'Honda', model: 'Africa Twin', year: 2019 },
    ],
    // Power user: gold across distance, rides, exploration, reviews, shares.
    rideCount: 210,
    baseRideKm: 58,
    roadsRiddenCount: 510,
    hazardCount: 28,
    reviewCount: 105,
    sharedRideCount: 51,
    tripCount: 4,
    follows: ['weekend.warrior@tarmoto.app', 'trip.planner@tarmoto.app'],
  },
  {
    email: 'trip.planner@tarmoto.app',
    display_name: 'Tereza Planner',
    bio: 'Spreadsheets, waypoints, and the perfect lunch stop. Then we ride.',
    subscription_tier: 'pro',
    home_region: 'Praha, CZ',
    home: { lat: 50.0755, lng: 14.4378 },
    joinedDaysAgo: 400,
    bikes: [{ make: 'BMW', model: 'R 1250 GS', year: 2021 }],
    // Trip-focused: several multi-day trips, modest riding.
    rideCount: 15,
    baseRideKm: 32,
    roadsRiddenCount: 30,
    hazardCount: 1,
    reviewCount: 2,
    sharedRideCount: 1,
    tripCount: 5,
    follows: ['road.hunter@tarmoto.app', 'community.scout@tarmoto.app'],
  },
  {
    email: 'community.scout@tarmoto.app',
    display_name: 'Cyril Scout',
    bio: 'Reporting potholes so you do not have to find them the hard way.',
    subscription_tier: 'pro',
    home_region: 'Ostrava, CZ',
    home: { lat: 49.8209, lng: 18.2625 },
    joinedDaysAgo: 600,
    bikes: [
      { make: 'Suzuki', model: 'V-Strom 650', year: 2020 },
      { make: 'Kawasaki', model: 'Versys 650', year: 2018 },
    ],
    // Community-focused: silver hazards/reviews/shares, solid riding.
    rideCount: 40,
    baseRideKm: 36,
    roadsRiddenCount: 60,
    hazardCount: 30,
    reviewCount: 30,
    sharedRideCount: 16,
    tripCount: 1,
    follows: [
      'newbie@tarmoto.app',
      'weekend.warrior@tarmoto.app',
      'road.hunter@tarmoto.app',
      'trip.planner@tarmoto.app',
    ],
  },
  {
    email: 'brno.rider@tarmoto.app',
    display_name: 'Bára Brno',
    bio: 'Moravian backroads from my doorstep in Zbýšov. Every route here is a ride I actually rode.',
    subscription_tier: 'pro',
    home_region: 'Brno, CZ',
    // Zbýšov u Brna — the hub most of the real rides start/end at.
    home: { lat: 49.1449, lng: 16.3953 },
    // Covers the ~2-year span of the real GPX history (the seeder rebases the
    // real ride dates so the newest lands ~today).
    joinedDaysAgo: 850,
    bikes: [{ make: 'Kawasaki', model: 'Z900', year: 2022 }],
    // Real recorded rides + planned trips from Calimoto GPX exports
    // (`real-demo-rides.data.ts`). rideCount/tripCount MUST equal the data
    // lengths — asserted in the spec.
    useRealGpx: true,
    rideCount: 67,
    baseRideKm: 50, // cosmetic; real rides carry their own distance
    roadsRiddenCount: 30,
    hazardCount: 4,
    reviewCount: 8,
    sharedRideCount: 10,
    tripCount: 4,
    follows: ['road.hunter@tarmoto.app', 'weekend.warrior@tarmoto.app'],
  },
];
