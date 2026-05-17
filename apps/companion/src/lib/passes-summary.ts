import type { paths } from "@tarmoto/openapi-client";

export type MountainPass = NonNullable<
  paths["/api/v1/passes"]["get"]["responses"][200]["content"]["application/json"]
>[number];

export type PassStatus = MountainPass["status"];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export function monthLabel(month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";
  return MONTH_NAMES[month - 1];
}

export function currentUtcMonth(now: Date = new Date()): MonthNumber {
  return (now.getUTCMonth() + 1) as MonthNumber;
}

export interface PassCounts {
  open: number;
  closed: number;
  unknown: number;
  total: number;
}

export function countByStatus(passes: readonly MountainPass[]): PassCounts {
  const counts: PassCounts = { open: 0, closed: 0, unknown: 0, total: 0 };
  for (const p of passes) {
    counts[p.status] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Groups passes by status and sorts each group highest-elevation first —
 * the most dramatic passes are the ones a rider most wants to know about
 * when deciding whether a month works for a trip.
 */
export function partitionByStatus(
  passes: readonly MountainPass[],
): Record<PassStatus, MountainPass[]> {
  const groups: Record<PassStatus, MountainPass[]> = {
    closed: [],
    unknown: [],
    open: [],
  };
  for (const p of passes) groups[p.status].push(p);
  for (const s of Object.keys(groups) as PassStatus[]) {
    groups[s].sort((a, b) => b.elevation_m - a.elevation_m);
  }
  return groups;
}

export function dedupePasses(passes: readonly MountainPass[]): MountainPass[] {
  const unique = new Map<string, MountainPass>();
  for (const pass of passes) {
    if (!unique.has(pass.id)) unique.set(pass.id, pass);
  }
  return [...unique.values()];
}

/**
 * Status ordering for the UI: closed first (the most actionable
 * information for trip planning), then unknown, then open.
 */
export const STATUS_DISPLAY_ORDER: readonly PassStatus[] = [
  "closed",
  "unknown",
  "open",
] as const;
