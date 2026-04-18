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
      return earnedAtMs(b.badge.earnedAt) - earnedAtMs(a.badge.earnedAt);
    }
    return a.badge.name.localeCompare(b.badge.name);
  });
}

/**
 * Parses `earnedAt` into a sortable timestamp. Invalid strings fall back to
 * `-Infinity` so they sort to the end rather than poisoning the comparator
 * with `NaN` (which `Array.sort` treats as unordered).
 */
function earnedAtMs(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

export function countEarnedBadges(entries: BadgeEntry[]): number {
  return entries.reduce((n, e) => (e.earned ? n + 1 : n), 0);
}

/**
 * Extracts up to 2 uppercase initials from a display name for avatar
 * fallbacks. Returns `"?"` when the name is empty, whitespace-only, or
 * otherwise yields no alphanumeric characters — without this guard
 * `"  Alice".split(/\s+/)` would produce an empty-string word whose
 * first char is `undefined`, joined to the literal string
 * `"undefined"`, and sliced to `"UN"`.
 */
export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "?";
  const letters = name
    .split(/\s+/)
    .map((word) => word[0])
    .filter((ch): ch is string => typeof ch === "string" && ch.length > 0)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
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
  let months =
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - date.getUTCMonth());
  // Calendar-month arithmetic overstates age when the day-of-month
  // hasn't been reached yet (e.g. joined Mar 20, now Apr 18 is 29 days,
  // not a full month). Future dates clamp to zero so ledger drift or
  // clock skew can't show "Joined -2 months ago". UTC accessors keep the
  // comparison timezone-agnostic so a user's locale can't flip the day.
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  if (months < 1) return "Joined this month";
  if (months < 12)
    return `Joined ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `Joined ${years} year${years === 1 ? "" : "s"} ago`;
}

export function formatKm(km: number): string {
  if (km < 1_000) return `${Math.round(km).toLocaleString()} km`;
  const k = km / 1000;
  // Values like 9,950 round to "10.0" at one decimal, which looked
  // inconsistent next to 10,000's "10k km" output. Promote anything
  // that would render as 10.0+ into the integer branch.
  if (k >= 9.95) return `${Math.round(k).toLocaleString()}k km`;
  return `${k.toFixed(1)}k km`;
}

export function formatCount(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString();
  const k = value / 1000;
  if (k >= 9.95) return `${Math.round(k).toLocaleString()}k`;
  return `${k.toFixed(1)}k`;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  // Mirror the formatKm/formatCount guard: values just under 100 round
  // to "100.0" at one decimal and would render inconsistently next to
  // 100's "100 h". Promote them into the integer branch.
  if (hours >= 99.95) return `${Math.round(hours).toLocaleString()} h`;
  return `${hours.toFixed(1)} h`;
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

  // The network fetch and the body parse are in separate try blocks on
  // purpose: only a network-level failure (endpoint genuinely not
  // reachable) should fall back to the demo profile. A 200 with a
  // malformed body is a backend contract regression and must surface as
  // an error so the page shows its error state instead of fake data.
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/community/riders/${encodeURIComponent(riderId)}`,
      { headers, signal: options.signal },
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    return { profile: buildDemoProfile(riderId), fromFallback: true };
  }

  if (res.ok) {
    try {
      const data = (await res.json()) as Partial<RiderProfileDetail>;
      return { profile: normalizeProfile(data, riderId), fromFallback: false };
    } catch (err) {
      throw new RiderProfileFetchError(
        err instanceof Error
          ? `Profile payload is invalid (${err.message})`
          : "Profile payload is invalid",
        res.status,
      );
    }
  }
  if (res.status === 404) {
    throw new RiderProfileNotFoundError(riderId);
  }
  throw new RiderProfileFetchError(
    `Profile request failed (${res.status})`,
    res.status,
  );
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
  const res = await fetch(
    `${API_BASE}/users/${encodeURIComponent(riderId)}/follow`,
    { method, headers },
  );
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
  // Build the demo profile lazily — on a well-formed API response (the
  // normal case) we never read from it, and `buildDemoProfile` allocates
  // bikes/badges/rides/collections we'd immediately throw away.
  let fallback: RiderProfileDetail | null = null;
  const getFallback = (): RiderProfileDetail => {
    fallback ??= buildDemoProfile(riderId);
    return fallback;
  };
  // `??` would let an empty/whitespace display name from the API sneak
  // through and poison downstream formatters (avatar initials, etc.).
  const rawName =
    typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  return {
    id: raw.id ?? riderId,
    displayName: rawName || getFallback().displayName,
    avatarUrl: raw.avatarUrl ?? undefined,
    bio: raw.bio,
    homeRegion: raw.homeRegion,
    bikes: Array.isArray(raw.bikes) ? raw.bikes : [],
    stats: normalizeStats(raw.stats, getFallback),
    badges: Array.isArray(raw.badges) ? raw.badges : [],
    isFollowing: Boolean(raw.isFollowing),
    recentRides: Array.isArray(raw.recentRides) ? raw.recentRides : [],
    collections: Array.isArray(raw.collections) ? raw.collections : [],
  };
}

/**
 * Guards every numeric field of `RiderStats` against `NaN`/`Infinity`/
 * missing values so downstream formatters can't emit "NaN km" or similar.
 * A non-object or missing payload returns the fallback wholesale.
 * `getFallback` is a thunk so the caller can defer demo-profile generation
 * until a field actually needs it.
 */
function normalizeStats(
  rawStats: unknown,
  getFallback: () => RiderProfileDetail,
): RiderStats {
  if (!rawStats || typeof rawStats !== "object") return getFallback().stats;
  const s = rawStats as Partial<RiderStats>;
  const isFiniteNumber = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  const isValidDate = (v: unknown): v is string =>
    typeof v === "string" && !Number.isNaN(new Date(v).getTime());
  // All-valid is the hot path — skip demo generation entirely.
  if (
    isFiniteNumber(s.totalKm) &&
    isFiniteNumber(s.totalRides) &&
    isFiniteNumber(s.totalHours) &&
    isFiniteNumber(s.roadsDiscovered) &&
    isFiniteNumber(s.hazardsReported) &&
    isValidDate(s.joinedAt)
  ) {
    return {
      totalKm: s.totalKm,
      totalRides: s.totalRides,
      totalHours: s.totalHours,
      roadsDiscovered: s.roadsDiscovered,
      hazardsReported: s.hazardsReported,
      joinedAt: s.joinedAt,
    };
  }
  const fallback = getFallback().stats;
  return {
    totalKm: isFiniteNumber(s.totalKm) ? s.totalKm : fallback.totalKm,
    totalRides: isFiniteNumber(s.totalRides)
      ? s.totalRides
      : fallback.totalRides,
    totalHours: isFiniteNumber(s.totalHours)
      ? s.totalHours
      : fallback.totalHours,
    roadsDiscovered: isFiniteNumber(s.roadsDiscovered)
      ? s.roadsDiscovered
      : fallback.roadsDiscovered,
    hazardsReported: isFiniteNumber(s.hazardsReported)
      ? s.hazardsReported
      : fallback.hazardsReported,
    joinedAt: isValidDate(s.joinedAt) ? s.joinedAt : fallback.joinedAt,
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
