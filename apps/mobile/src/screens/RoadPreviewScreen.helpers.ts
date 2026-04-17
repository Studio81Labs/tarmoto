/**
 * Pure formatting helpers for RoadPreviewScreen.
 *
 * Kept in a separate module from the screen so tests can exercise them
 * without pulling React Native, navigation, or theme into the module graph.
 */

export function formatLengthKm(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function formatSurface(surface: string): string {
  return surface.charAt(0).toUpperCase() + surface.slice(1);
}

export function formatHazardType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffS = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffS < 60) return "just now";
  const mins = Math.floor(diffS / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function curvinessLabel(score: number): string {
  if (score >= 4.5) return "Very twisty — a full-on playground.";
  if (score >= 3.5) return "Plenty of curves to lean into.";
  if (score >= 2.5) return "Mixed — sweepers with occasional straights.";
  if (score >= 1.5) return "Mostly straight with a few bends.";
  return "Straight, transit-style road.";
}

/**
 * Normalize a quality breakdown into display-ready segments.
 * Filters out non-positive entries and returns an empty array if total ≤ 0.
 */
export function normalizeBreakdown<K extends string>(
  keys: readonly K[],
  breakdown: Record<K, number>,
): Array<{ key: K; pct: number }> {
  const total = keys.reduce(
    (acc, k) => acc + Math.max(0, breakdown[k] || 0),
    0,
  );
  if (total <= 0) return [];
  return keys
    .map((k) => ({ key: k, pct: Math.max(0, breakdown[k] || 0) / total }))
    .filter((e) => e.pct > 0);
}
