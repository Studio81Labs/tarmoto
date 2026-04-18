/**
 * Pure helpers for the public rider profile page (US-54).
 *
 * The companion uses a single DTO-ish shape (`RiderProfileDetail`) returned
 * either from the forthcoming `/community/riders/:id` endpoint or from the
 * local demo generator. Keeping shape and helpers here lets the page stay
 * thin and the derivations testable without React.
 *
 * Follow/unfollow hit the existing `/users/:userId/follow` endpoint on the
 * backend; we never need it to return the full profile so those wrappers are
 * kept separate from the fetcher.
 */

import type {
  Badge,
  Bike,
  RiderProfile,
  RiderStats,
  RouteCollection,
} from "@/lib/types";
import { API_BASE } from "@/lib/config";

/**
 * One shared ride surfaced in the rider's recent-activity feed. Kept minimal
 * because the profile shows a summary card — the ride detail page (US-48) is
 * where the full breakdown lives.
 */
export interface RiderRideSummary {
  id: string;
  name?: string;
  startedAt: string;
  distanceKm: number;
  durationMinutes: number;
  avgQuality: number;
  region?: string;
}

/**
 * Full payload used to render the rider profile. Extends the base
 * `RiderProfile` (already defined in `types.ts` for the wider app) with the
 * activity feed + collection slices that are profile-specific.
 */
export interface RiderProfileDetail extends RiderProfile {
  recentRides: RiderRideSummary[];
  collections: RouteCollection[];
}

// ── Derived views ──

export interface StatTile {
  key: keyof RiderStats;
  label: string;
  value: string;
}

export interface BadgeEntry {
  badge: Badge;
  earned: boolean;
  earnedLabel: string | null;
}

/**
 * Builds the 4-tile header stats row. "Hazards reported" is surfaced despite
 * not being strictly a stat — it signals contribution and community trust,
 * which is the main reason a visitor lands on a profile.
 */
export function buildStatTiles(stats: RiderStats): StatTile[] {
  return [
    {
      key: "totalRides",
      label: "Rides shared",
      value: formatCount(stats.totalRides),
    },
    {
      key: "totalKm",
      label: "Kilometres ridden",
      value: formatKm(stats.totalKm),
    },
    {
      key: "roadsDiscovered",
      label: "Roads discovered",
      value: formatCount(stats.roadsDiscovered),
    },
    {
      key: "hazardsReported",
      label: "Hazards reported",
      value: formatCount(stats.hazardsReported),
    },
  ];
}

/**
 * Sort earned badges first (most recently earned on top), then locked ones.
 * We keep locked badges in the grid because they hint at what the rider is
 * working toward, which is part of the social signal of the profile.
 */
export function sortBadges(badges: Badge[]): BadgeEntry[] {
  const entries = badges.map<BadgeEntry>((badge) => ({
    badge,
    earned: Boolean(badge.earnedAt),
    earnedLabel: badge.earnedAt ? formatEarnedLabel(badge.earnedAt) : null,
  }));
  return entries.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    if (a.earned && b.earned) {
      return (
        new Date(b.badge.earnedAt ?? 0).getTime() -
        new Date(a.badge.earnedAt ?? 0).getTime()
      );
    }
    return a.badge.name.localeCompare(b.badge.name);
  });
}

export function countEarnedBadges(entries: BadgeEntry[]): number {
  return entries.reduce((n, e) => (e.earned ? n + 1 : n), 0);
}

/**
 * Returns the rider's single highlighted bike (active bike preferred, else
 * the most-ridden). Used in the header — the full garage is on the account
 * page, not the public profile.
 */
export function pickShowcaseBike(bikes: Bike[]): Bike | null {
  if (bikes.length === 0) return null;
  const active = bikes.find((b) => b.isActive);
  if (active) return active;
  return [...bikes].sort((a, b) => b.totalKm - a.totalKm)[0];
}

export function formatJoinedLabel(
  joinedAt: string,
  now: Date = new Date(),
): string {
  const date = new Date(joinedAt);
  if (Number.isNaN(date.getTime())) return "Joined recently";
  const months =
    (now.getFullYear() - date.getFullYear()) * 12 +
    (now.getMonth() - date.getMonth());
  if (months < 1) return "Joined this month";
  if (months < 12)
    return `Joined ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `Joined ${years} year${years === 1 ? "" : "s"} ago`;
}

export function formatKm(km: number): string {
  if (km >= 10_000) return `${Math.round(km / 1000).toLocaleString()}k km`;
  if (km >= 1_000) return `${(km / 1000).toFixed(1)}k km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatCount(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1000).toLocaleString()}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 100) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours).toLocaleString()} h`;
}

function formatEarnedLabel(earnedAt: string): string {
  const date = new Date(earnedAt);
  if (Number.isNaN(date.getTime())) return "Earned";
  return `Earned ${date.toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
  })}`;
}

// ── Fetch + follow API ──

/**
 * Loads the rider profile. The public profile endpoint is still spec-pending
 * (tracked by #71 / account epic), so a network failure (endpoint genuinely
 * missing) falls back to the deterministic demo profile. A successful 404
 * means the rider doesn't exist and surfaces a not-found state; any other
 * non-OK response is a real server error and propagates so the page can show
 * its error state rather than quietly pretending with fake data.
 */
export async function fetchRiderProfile(
  riderId: string,
  options: { signal?: AbortSignal; accessToken?: string | null } = {},
): Promise<{ profile: RiderProfileDetail; fromFallback: boolean }> {
  const headers: Record<string, string> = {};
  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  try {
    const res = await fetch(`${API_BASE}/community/riders/${riderId}`, {
      headers,
      signal: options.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as RiderProfileDetail;
      return { profile: normalizeProfile(data, riderId), fromFallback: false };
    }
    if (res.status === 404) {
      throw new RiderProfileNotFoundError(riderId);
    }
    throw new RiderProfileFetchError(
      `Profile request failed (${res.status})`,
      res.status,
    );
  } catch (err) {
    if (err instanceof RiderProfileNotFoundError) throw err;
    if (err instanceof RiderProfileFetchError) throw err;
    if ((err as { name?: string })?.name === "AbortError") throw err;
    // Only reach here for network-level failures (fetch reject, JSON parse,
    // etc.) — endpoint not reachable at all, so fall back to demo so the
    // page stays usable in dev/CI before the backend route exists.
  }

  return { profile: buildDemoProfile(riderId), fromFallback: true };
}

export class RiderProfileNotFoundError extends Error {
  constructor(public readonly riderId: string) {
    super(`Rider ${riderId} not found`);
    this.name = "RiderProfileNotFoundError";
  }
}

export class RiderProfileFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RiderProfileFetchError";
  }
}

export async function followRider(
  riderId: string,
  accessToken: string | null,
): Promise<void> {
  await mutateFollow(riderId, "POST", accessToken);
}

export async function unfollowRider(
  riderId: string,
  accessToken: string | null,
): Promise<void> {
  await mutateFollow(riderId, "DELETE", accessToken);
}

async function mutateFollow(
  riderId: string,
  method: "POST" | "DELETE",
  accessToken: string | null,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${API_BASE}/users/${riderId}/follow`, {
    method,
    headers,
  });
  if (!res.ok) {
    // 409 (already following) on POST and 404 (not following) on DELETE are
    // idempotent from the user's perspective — treat them as success so the
    // UI doesn't flicker when a stale state races against a click.
    if (method === "POST" && res.status === 409) return;
    if (method === "DELETE" && res.status === 404) return;
    throw new Error(`Follow request failed (${res.status})`);
  }
}

// ── Demo data ──

/**
 * Generates a rich, deterministic profile keyed by `riderId` so the page looks
 * real when the backend endpoint is not yet wired. Used as a fallback in
 * `fetchRiderProfile` and directly by tests so the UI can be driven from one
 * shape regardless of environment.
 */
export function buildDemoProfile(riderId: string): RiderProfileDetail {
  const seed = hashSeed(riderId);
  const name = pick(DEMO_NAMES, seed);
  const region = pick(DEMO_REGIONS, seed + 1);
  const bikes: Bike[] = [
    {
      id: `${riderId}-bike-1`,
      make: "Yamaha",
      model: "Ténéré 700",
      year: 2023,
      isActive: true,
      totalKm: 12_340,
      totalRides: 84,
    },
    {
      id: `${riderId}-bike-2`,
      make: "Honda",
      model: "CB650R",
      year: 2021,
      isActive: false,
      totalKm: 4_210,
      totalRides: 37,
    },
  ];
  const stats: RiderStats = {
    totalKm: 16_550,
    totalRides: 121,
    totalHours: 412.5,
    roadsDiscovered: 284,
    hazardsReported: 47,
    joinedAt: daysAgo(720, seed),
  };
  const badges: Badge[] = [
    {
      id: "pioneer",
      name: "Pioneer",
      description: "First to map 100 roads.",
      icon: "compass",
      earnedAt: daysAgo(180, seed),
    },
    {
      id: "mountain-hunter",
      name: "Mountain hunter",
      description: "Ride 10 mountain passes.",
      icon: "mountain",
      earnedAt: daysAgo(90, seed + 2),
    },
    {
      id: "night-owl",
      name: "Night owl",
      description: "Finish 5 rides after sunset.",
      icon: "moon",
      earnedAt: daysAgo(32, seed + 3),
    },
    {
      id: "curves-1000",
      name: "1000 curves",
      description: "Link 1,000 curves in a single month.",
      icon: "wind",
    },
    {
      id: "legend",
      name: "Legend",
      description: "Reach 100,000 km on a single bike.",
      icon: "trophy",
    },
  ];
  const collections: RouteCollection[] = [
    {
      id: `${riderId}-col-1`,
      name: "Best of Beskydy",
      description: "Favourite twisty loops near home.",
      riderId,
      riderName: name,
      routes: [],
      isPublic: true,
      createdAt: daysAgo(120, seed),
    },
    {
      id: `${riderId}-col-2`,
      name: "Alps weekend",
      description: "Two-day sweep across Grossglockner and Stelvio.",
      riderId,
      riderName: name,
      routes: [],
      isPublic: true,
      createdAt: daysAgo(60, seed + 1),
    },
  ];
  const recentRides: RiderRideSummary[] = [
    {
      id: `${riderId}-ride-1`,
      name: "Sunday Beskydy loop",
      startedAt: daysAgo(4, seed),
      distanceKm: 184,
      durationMinutes: 262,
      avgQuality: 4.2,
      region,
    },
    {
      id: `${riderId}-ride-2`,
      name: "Dawn commute detour",
      startedAt: daysAgo(9, seed + 1),
      distanceKm: 57,
      durationMinutes: 88,
      avgQuality: 3.6,
      region,
    },
    {
      id: `${riderId}-ride-3`,
      name: "Vsetín gravel explorer",
      startedAt: daysAgo(14, seed + 2),
      distanceKm: 112,
      durationMinutes: 201,
      avgQuality: 3.1,
      region,
    },
  ];

  return {
    id: riderId,
    displayName: name,
    avatarUrl: undefined,
    bio: `Riding ${region}, chasing twisties, mapping the rest.`,
    homeRegion: region,
    bikes,
    stats,
    badges,
    isFollowing: false,
    recentRides,
    collections,
  };
}

/**
 * Normalises a profile payload from the backend: clamps missing arrays to
 * empty, rejects malformed numbers, and keeps `isFollowing` as the
 * authoritative source from the API (falling back to `false`).
 */
function normalizeProfile(
  raw: Partial<RiderProfileDetail>,
  riderId: string,
): RiderProfileDetail {
  const fallback = buildDemoProfile(riderId);
  return {
    id: raw.id ?? riderId,
    displayName: raw.displayName ?? fallback.displayName,
    avatarUrl: raw.avatarUrl ?? undefined,
    bio: raw.bio,
    homeRegion: raw.homeRegion,
    bikes: Array.isArray(raw.bikes) ? raw.bikes : [],
    stats: raw.stats ?? fallback.stats,
    badges: Array.isArray(raw.badges) ? raw.badges : [],
    isFollowing: Boolean(raw.isFollowing),
    recentRides: Array.isArray(raw.recentRides) ? raw.recentRides : [],
    collections: Array.isArray(raw.collections) ? raw.collections : [],
  };
}

// ── Demo helpers ──

const DEMO_NAMES = [
  "Karolína Dvořáková",
  "Marek Novák",
  "Petra Horáková",
  "Tomáš Svoboda",
  "Lenka Procházková",
];

const DEMO_REGIONS = [
  "Beskydy",
  "Moravian Karst",
  "Šumava",
  "Jeseníky",
  "Krkonoše",
];

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 997;
}

function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length];
}

function daysAgo(days: number, seed: number): string {
  // Deterministic date keyed by seed so tests and repeat renders stay stable.
  const jitter = seed % 7;
  const offset = (days + jitter) * 24 * 60 * 60 * 1000;
  return new Date(Date.UTC(2026, 3, 18) - offset).toISOString();
}
