import { haversineKm } from '@tarmoto/shared';

/**
 * Cross-source POI de-duplication for the store reads (#869). OSM and FSQ both
 * store, say, a restaurant at ~the same spot, so a naive read returns duplicate
 * pins. We keep the **higher-preference** source's row and drop a lower one that
 * duplicates it — OSM wins over FSQ (it carries the richer decision-support:
 * opening hours, cuisine, brand), and FSQ then only *adds* rows where OSM has
 * nothing, filling coverage without doubling.
 *
 * A no-op until FSQ is actually imported (a single-source result never
 * de-dupes), so it's safe to run on every store read regardless of coverage.
 */
const SOURCE_RANK: Record<string, number> = { osm: 0, fsq: 1 };
function sourceRank(source: string): number {
  return SOURCE_RANK[source] ?? 2;
}

/**
 * ~50 m. OSM vs FSQ coordinates for the SAME venue differ by up to a few tens of
 * metres; two *distinct* same-name same-kind venues (chain locations) are rarely
 * this close — so a name match within this radius is a confident duplicate,
 * while nearby-but-separate branches stay separate.
 */
const DEDUP_RADIUS_KM = 0.05;

export interface DedupPoi {
  source: string;
  kind: string;
  name: string | null;
  lat: number;
  lng: number;
}

/**
 * The source of a POI from its `<source>:<id>` external id (e.g. `osm:node:42`
 * → `osm`, `fsq:abc` → `fsq`) — for de-dup keys where only the external id is at
 * hand (the along-route ranker's `PointOfInterest` carries no `source` field).
 */
export function sourceOfExternalId(externalId: string): string {
  return externalId.split(':')[0] ?? externalId;
}

/**
 * Lower-case, strip combining accents, drop punctuation, collapse spaces; null
 * if empty. Uses a Unicode letter/number class (`\p{L}\p{N}`), not `[a-z0-9]`,
 * so non-Latin names in the coverage regions (Greek `Ταβέρνα`, Cyrillic
 * `Кафана`) survive normalisation and can still match across sources.
 */
function normalizeName(name: string | null): string | null {
  if (!name) return null;
  const normalized = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return normalized || null;
}

/**
 * True when two names are confidently the same venue: equal after
 * normalisation, or one contains the other (e.g. "Café" vs "Café Central") —
 * but only when the shorter name is ≥ 3 chars, so a 1–2 char token can't
 * over-merge. A missing name on either side can't confirm a duplicate.
 */
function nameMatches(a: string | null, b: string | null): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 3 && long.includes(short);
}

/**
 * De-duplicate `rows` across sources, keeping the input order of survivors.
 * `key` projects a row to its `{source, kind, name, lat, lng}`. A row is dropped
 * only when an already-kept row from a STRICTLY preferred source of the SAME
 * kind sits within {@link DEDUP_RADIUS_KM} with a matching name — so same-source
 * neighbours are never merged and a single-source read is unchanged.
 */
export function dedupeAcrossSources<T>(
  rows: readonly T[],
  key: (row: T) => DedupPoi,
): T[] {
  // Visit higher-preference sources first (OSM before FSQ), stable within a rank
  // by original index, so an FSQ duplicate is dropped in favour of the OSM row.
  const ordered = rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort(
      (a, b) => sourceRank(a.k.source) - sourceRank(b.k.source) || a.i - b.i,
    );
  const kept: { row: T; i: number; k: DedupPoi }[] = [];
  for (const entry of ordered) {
    const isDup = kept.some(
      (other) =>
        // Only a STRICTLY preferred (higher-rank) source de-dupes this row.
        // Two same-source POIs near each other — distinct venues, or the same
        // OSM chain mapped twice — are both kept, so a single-source read is
        // untouched and "keep every OSM row" holds.
        sourceRank(other.k.source) < sourceRank(entry.k.source) &&
        other.k.kind === entry.k.kind &&
        haversineKm(other.k.lat, other.k.lng, entry.k.lat, entry.k.lng) <=
          DEDUP_RADIUS_KM &&
        nameMatches(other.k.name, entry.k.name),
    );
    if (!isDup) kept.push(entry);
  }
  // Restore input order so callers that don't re-sort are unaffected.
  return kept.sort((a, b) => a.i - b.i).map((e) => e.row);
}
