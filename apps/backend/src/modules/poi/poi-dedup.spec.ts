import { dedupeAcrossSources, type DedupPoi } from './poi-dedup.js';

interface Row extends DedupPoi {
  id: string;
}

function row(over: Partial<Row>): Row {
  return {
    id: 'x',
    source: 'osm',
    kind: 'restaurant',
    name: 'U Fleku',
    lat: 50.08,
    lng: 14.42,
    ...over,
  };
}

const dedupe = (rows: Row[]): string[] =>
  dedupeAcrossSources(rows, (r) => r).map((r) => r.id);

describe('dedupeAcrossSources', () => {
  it('drops an FSQ row duplicating an OSM row (same kind, <50 m, same name)', () => {
    const rows = [
      row({ id: 'osm', source: 'osm', lat: 50.08 }),
      // ~22 m north, accented spelling of the same venue.
      row({ id: 'fsq', source: 'fsq', name: 'U Fleků', lat: 50.0802 }),
    ];
    expect(dedupe(rows)).toEqual(['osm']); // OSM kept, FSQ dropped
  });

  it('keeps an FSQ row with no OSM match (fills coverage)', () => {
    const rows = [
      row({ id: 'osm', source: 'osm', name: 'U Fleku' }),
      row({ id: 'fsq', source: 'fsq', name: 'Costa', lat: 50.09, lng: 14.43 }),
    ];
    expect(dedupe(rows).sort()).toEqual(['fsq', 'osm']);
  });

  it('keeps both when the name matches but the kind differs', () => {
    const rows = [
      row({ id: 'osm', source: 'osm', kind: 'restaurant', name: 'Central' }),
      row({ id: 'fsq', source: 'fsq', kind: 'cafe', name: 'Central' }),
    ];
    expect(dedupe(rows).sort()).toEqual(['fsq', 'osm']);
  });

  it('keeps both same-name same-kind venues when far apart (distinct branches)', () => {
    const rows = [
      row({ id: 'osm', source: 'osm', name: 'Starbucks', kind: 'cafe' }),
      // ~110 m away — a different branch, not a duplicate.
      row({
        id: 'fsq',
        source: 'fsq',
        name: 'Starbucks',
        kind: 'cafe',
        lat: 50.081,
      }),
    ];
    expect(dedupe(rows).sort()).toEqual(['fsq', 'osm']);
  });

  it('matches on a contained name only when the shorter is ≥3 chars', () => {
    const near = { lat: 50.081, lng: 14.421 };
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', kind: 'cafe', name: 'Café', ...near }),
        row({
          id: 'fsq',
          source: 'fsq',
          kind: 'cafe',
          name: 'Café Central',
          ...near,
        }),
      ]),
    ).toEqual(['osm']); // "cafe" ⊂ "cafe central" → dropped
    // A 2-char name must not over-merge into a longer one.
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', kind: 'cafe', name: 'Ku', ...near }),
        row({
          id: 'fsq',
          source: 'fsq',
          kind: 'cafe',
          name: 'Kubista',
          ...near,
        }),
      ]).sort(),
    ).toEqual(['fsq', 'osm']);
  });

  it('matches names differing only by an apostrophe (possessive brands)', () => {
    const near = { lat: 50.081, lng: 14.421 };
    // OSM keeps the possessive apostrophe, FSQ drops it — the same venue.
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', name: "McDonald's", ...near }),
        row({ id: 'fsq', source: 'fsq', name: 'McDonalds', ...near }),
      ]),
    ).toEqual(['osm']); // apostrophe removed on both → mcdonalds ≡ mcdonalds
    // Typographic apostrophe + leading-apostrophe brand.
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', name: 'L’Osteria', ...near }),
        row({ id: 'fsq', source: 'fsq', name: 'LOsteria', ...near }),
      ]),
    ).toEqual(['osm']); // losteria ≡ losteria
  });

  it('keeps hyphen and space as equivalent separators (Coca-Cola ≡ Coca Cola)', () => {
    const near = { lat: 50.081, lng: 14.421 };
    // A hyphen stays a separator (→ space), so the spaced and hyphenated
    // spellings of one brand still match — unlike the apostrophe, which is
    // removed. Guards against a fix that squeezes all punctuation away.
    expect(
      dedupe([
        row({
          id: 'osm',
          source: 'osm',
          kind: 'cafe',
          name: 'Coca-Cola',
          ...near,
        }),
        row({
          id: 'fsq',
          source: 'fsq',
          kind: 'cafe',
          name: 'Coca Cola',
          ...near,
        }),
      ]),
    ).toEqual(['osm']);
  });

  it('matches non-Latin names across sources (Greek / Cyrillic coverage)', () => {
    const near = { lat: 50.081, lng: 14.421 };
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', name: 'Ταβέρνα', ...near }),
        row({ id: 'fsq', source: 'fsq', name: 'Ταβέρνα', ...near }),
      ]),
    ).toEqual(['osm']); // Greek duplicate matched + dropped
    expect(
      dedupe([
        row({ id: 'osm', source: 'osm', name: 'Кафана', ...near }),
        row({ id: 'fsq', source: 'fsq', name: 'Кафана', ...near }),
      ]),
    ).toEqual(['osm']); // Cyrillic duplicate matched + dropped
  });

  it('never de-dupes when a name is missing on either side', () => {
    const near = { lat: 50.081, lng: 14.421 };
    const rows = [
      row({ id: 'osm', source: 'osm', kind: 'viewpoint', name: null, ...near }),
      row({ id: 'fsq', source: 'fsq', kind: 'viewpoint', name: null, ...near }),
    ];
    expect(dedupe(rows).sort()).toEqual(['fsq', 'osm']);
  });

  it('preserves input order among the survivors', () => {
    const rows = [
      row({ id: 'a', source: 'osm', name: 'A', lat: 50.0, lng: 14.0 }),
      row({ id: 'b', source: 'fsq', name: 'B', lat: 50.5, lng: 14.5 }),
      row({ id: 'c', source: 'osm', name: 'C', lat: 51.0, lng: 15.0 }),
    ];
    expect(dedupe(rows)).toEqual(['a', 'b', 'c']);
  });

  it("gives a surviving OSM row its duplicate group's earliest position (#869)", () => {
    // Nearest-first input: the FSQ copy is first, its preferred OSM twin last,
    // with unrelated OSM rows in between. The OSM survivor must inherit the FSQ's
    // earlier position (index 0), not keep its own (index 3) — otherwise a
    // downstream slice/cap by this order could trim a venue whose FSQ copy sat
    // inside the cap while the OSM twin sat just outside it.
    const rows = [
      row({ id: 'fsq', source: 'fsq', name: 'Koliba', lat: 50.08 }),
      row({ id: 'x1', source: 'osm', name: 'Alpha', lat: 50.2, lng: 14.6 }),
      row({ id: 'x2', source: 'osm', name: 'Beta', lat: 50.3, lng: 14.7 }),
      // ~22 m from the FSQ copy, same kind + name → its preferred twin.
      row({ id: 'osm', source: 'osm', name: 'Koliba', lat: 50.0802 }),
    ];
    // FSQ dropped; the OSM survivor sorts to the front (the group's index 0),
    // ahead of the unrelated rows — not to its own trailing index.
    expect(dedupe(rows)).toEqual(['osm', 'x1', 'x2']);
  });

  it('never merges two same-source POIs near each other (single-source no-op)', () => {
    // Two legitimately-distinct OSM restaurants with the same name ~22 m apart
    // (a chain mapped twice, or genuinely separate) must BOTH survive — only a
    // strictly-preferred source de-dupes, so an OSM-only read is untouched.
    const rows = [
      row({ id: 'a', source: 'osm', kind: 'restaurant', name: 'Pizza Nuova' }),
      row({
        id: 'b',
        source: 'osm',
        kind: 'restaurant',
        name: 'Pizza Nuova',
        lat: 50.0802,
      }),
    ];
    expect(dedupe(rows).sort()).toEqual(['a', 'b']);
  });
});
