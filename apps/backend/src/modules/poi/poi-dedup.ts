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
 *
 * Apostrophes (straight, typographic, or modifier-letter) are *removed*, not
 * turned into a space, so a source that keeps the possessive punctuation and
 * one that drops it still match: `McDonald's` ≡ `McDonalds`, `L'Osteria` ≡
 * `LOsteria`. Hyphens stay separators (→ space) so `Coca-Cola` ≡ `Coca Cola`.
 */
function normalizeName(name: string | null): string | null {
  if (!name) return null;
  const normalized = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Drop intra-word apostrophes before spacing other punctuation, so the
    // apostrophe doesn't split one token into two.
    .replace(/['’ʼ]/g, '')
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
 * De-duplicate `rows` across sources, ordering survivors by their duplicate
 * group's EARLIEST input position. `key` projects a row to its
 * `{source, kind, name, lat, lng}`. A row is dropped only when an already-kept
 * row from a STRICTLY preferred source of the SAME kind sits within
 * {@link DEDUP_RADIUS_KM} with a matching name — so same-source neighbours are
 * never merged and a single-source read keeps its input order unchanged.
 *
 * `mergeDuplicate`, when given, folds a dropped duplicate's data into the kept
 * survivor (returning the updated survivor). Use it to carry a ranking
 * attribute the dropped copy did BETTER on — e.g. a closer route distance — so a
 * downstream sort/cap ranks the venue by its best group member, not by the
 * replacement row's own (possibly worse) value.
 */
export function dedupeAcrossSources<T>(
  rows: readonly T[],
  key: (row: T) => DedupPoi,
  mergeDuplicate?: (kept: T, dropped: T) => T,
): T[] {
  // Visit higher-preference sources first (OSM before FSQ), stable within a rank
  // by original index, so an FSQ duplicate is dropped in favour of the OSM row.
  const ordered = rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort(
      (a, b) => sourceRank(a.k.source) - sourceRank(b.k.source) || a.i - b.i,
    );
  // `pos` tracks the EARLIEST input index of a survivor's duplicate group, not
  // the kept row's own index. When a preferred row (OSM) absorbs an earlier
  // lower-preference duplicate (an FSQ copy nearer the front of a nearest-first
  // read), the survivor inherits that earlier position — otherwise a caller that
  // over-fetches then `slice`s/caps by this order could trim away a venue whose
  // FSQ copy sat inside the cap while the OSM twin sat just outside it.
  const kept: { row: T; pos: number; k: DedupPoi }[] = [];
  for (const entry of ordered) {
    const twin = kept.find(
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
    if (twin) {
      // Drop this duplicate, but let its preferred twin keep the earliest
      // position the group reached in the input, and fold in any ranking
      // attribute the dropped copy did better on.
      twin.pos = Math.min(twin.pos, entry.i);
      if (mergeDuplicate) twin.row = mergeDuplicate(twin.row, entry.row);
    } else {
      kept.push({ row: entry.row, pos: entry.i, k: entry.k });
    }
  }
  // Order survivors by their group's earliest position, so a caller that trims
  // by nearest-first order keeps the closest member of each duplicate group.
  return kept.sort((a, b) => a.pos - b.pos).map((e) => e.row);
}
