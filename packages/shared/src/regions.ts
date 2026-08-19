/**
 * Curated catalog of motorcycle-riding regions used by the "Best Roads"
 * SEO pages. The companion's generateStaticParams and the backend's
 * /roads/best endpoint both consume this file — a single source of truth
 * means we can change regions without migrations.
 *
 * Add a new region by appending to REGIONS (and COUNTRIES if new country).
 * Slugs are lowercase kebab-case ASCII; country codes are ISO 3166-1
 * alpha-2 lowercased.
 */

export interface Region {
  slug: string;
  country: string;
  /** Operational name used by backend matching and third-party map data. */
  name: string;
  /** Stable client-catalog key for the rider-facing name. */
  nameKey: RegionNameKey;
  /** Parent region slug for sub-regions. Undefined for top-level regions. */
  parent?: string;
  /** [west, south, east, north] in WGS84 degrees. */
  bbox: [number, number, number, number];
  center: { lat: number; lng: number };
  defaultZoom: number;
  descriptionKey: RegionDescriptionKey;
  bestSeason?: MonthRange;
}

export interface Country {
  code: string;
  /** Operational English name retained for external data matching. */
  name: string;
  /** Stable client-catalog key for the rider-facing name. */
  nameKey: CountryNameKey;
}

export type CountryNameKey = "Czech Republic" | "Austria" | "Italy";

export type RegionNameKey =
  "Beskydy" | "Jeseníky" | "Šumava" | "Tyrol" | "Alpine Passes" | "Dolomites";

export type RegionDescriptionKey =
  | "The Moravian-Silesian Beskydy range climbs from the Ostrava basin into rolling forested ridgelines. Narrow ridge roads, long sweeping descents, and the iconic climb to Lysá hora make it a favourite weekend loop."
  | "Higher and colder than the Beskydy, the Jeseníky mountains offer open highland roads over Červenohorské sedlo and the long sweeping arcs around Praděd — the tallest peak in Moravia."
  | "Long, quiet forest roads trace the Czech-Bavarian border through the Šumava national park. Lower elevation than the Alps but rewarding for pure riding flow over long distances."
  | "The heart of the Austrian Alps. Hairpin-stitched passes, glacier-fed valleys and the highest paved road in Austria — Tyrol packs more legendary motorcycle roads into one province than most countries."
  | "The signature high passes of Tyrol — Timmelsjoch, Hahntennjoch, Silvretta-Hochalpenstraße — collected onto a single route list."
  | "Jagged limestone spires frame a web of hairpin roads — Passo Pordoi, Passo Sella, Passo Giau — each a riding pilgrimage in its own right.";

export type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface MonthRange {
  start: MonthNumber;
  end: MonthNumber;
}

export const COUNTRIES: readonly Country[] = [
  {
    code: "cz",
    name: "Czech Republic",
    nameKey: "Czech Republic",
  },
  { code: "at", name: "Austria", nameKey: "Austria" },
  { code: "it", name: "Italy", nameKey: "Italy" },
];

export const REGIONS: readonly Region[] = [
  {
    slug: "beskydy",
    country: "cz",
    name: "Beskydy",
    nameKey: "Beskydy",
    bbox: [18.0, 49.3, 18.85, 49.7],
    center: { lat: 49.5, lng: 18.4 },
    defaultZoom: 10,
    descriptionKey:
      "The Moravian-Silesian Beskydy range climbs from the Ostrava basin into rolling forested ridgelines. Narrow ridge roads, long sweeping descents, and the iconic climb to Lysá hora make it a favourite weekend loop.",
    bestSeason: { start: 5, end: 10 },
  },
  {
    slug: "jeseniky",
    country: "cz",
    name: "Jeseníky",
    nameKey: "Jeseníky",
    bbox: [16.85, 49.85, 17.6, 50.25],
    center: { lat: 50.05, lng: 17.2 },
    defaultZoom: 10,
    descriptionKey:
      "Higher and colder than the Beskydy, the Jeseníky mountains offer open highland roads over Červenohorské sedlo and the long sweeping arcs around Praděd — the tallest peak in Moravia.",
    bestSeason: { start: 6, end: 9 },
  },
  {
    slug: "sumava",
    country: "cz",
    name: "Šumava",
    nameKey: "Šumava",
    bbox: [13.2, 48.55, 14.5, 49.35],
    center: { lat: 48.95, lng: 13.85 },
    defaultZoom: 9,
    descriptionKey:
      "Long, quiet forest roads trace the Czech-Bavarian border through the Šumava national park. Lower elevation than the Alps but rewarding for pure riding flow over long distances.",
    bestSeason: { start: 5, end: 10 },
  },
  {
    slug: "tyrol",
    country: "at",
    name: "Tyrol",
    nameKey: "Tyrol",
    bbox: [10.1, 46.65, 12.8, 47.7],
    center: { lat: 47.2, lng: 11.4 },
    defaultZoom: 8,
    descriptionKey:
      "The heart of the Austrian Alps. Hairpin-stitched passes, glacier-fed valleys and the highest paved road in Austria — Tyrol packs more legendary motorcycle roads into one province than most countries.",
    bestSeason: { start: 6, end: 9 },
  },
  {
    slug: "alpine-passes",
    country: "at",
    parent: "tyrol",
    name: "Alpine Passes",
    nameKey: "Alpine Passes",
    bbox: [10.5, 46.8, 12.5, 47.4],
    center: { lat: 47.1, lng: 11.5 },
    defaultZoom: 9,
    descriptionKey:
      "The signature high passes of Tyrol — Timmelsjoch, Hahntennjoch, Silvretta-Hochalpenstraße — collected onto a single route list.",
    bestSeason: { start: 7, end: 9 },
  },
  {
    slug: "dolomites",
    country: "it",
    name: "Dolomites",
    nameKey: "Dolomites",
    bbox: [10.8, 46.2, 12.5, 46.85],
    center: { lat: 46.5, lng: 11.75 },
    defaultZoom: 9,
    descriptionKey:
      "Jagged limestone spires frame a web of hairpin roads — Passo Pordoi, Passo Sella, Passo Giau — each a riding pilgrimage in its own right.",
    bestSeason: { start: 6, end: 9 },
  },
];

export function findCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

export function findRegion(country: string, slug: string): Region | undefined {
  return REGIONS.find((r) => r.country === country && r.slug === slug);
}

export function findCountryRegions(country: string): Region[] {
  return REGIONS.filter((r) => r.country === country && !r.parent);
}

export function findSubRegions(country: string, parent: string): Region[] {
  return REGIONS.filter((r) => r.country === country && r.parent === parent);
}

export function listIndexableRegions(): Region[] {
  return [...REGIONS];
}

/**
 * Run at module load to catch catalog typos immediately — duplicate slugs,
 * unknown country codes, unresolved parents, inside-out bboxes. Any error
 * here fails the build of whichever package imports the catalog.
 */
function assertCatalogValid(): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  const countryCodes = new Set(COUNTRIES.map((c) => c.code));

  for (const r of REGIONS) {
    const key = `${r.country}/${r.slug}`;
    if (seen.has(key)) errors.push(`duplicate region: ${key}`);
    seen.add(key);
    if (!countryCodes.has(r.country)) {
      errors.push(`unknown country '${r.country}' on region ${r.slug}`);
    }
    const [w, s, e, n] = r.bbox;
    if (!(w < e && s < n)) {
      errors.push(`invalid bbox on ${key}: [${w},${s},${e},${n}]`);
    }
  }
  for (const r of REGIONS) {
    if (r.parent) {
      const parent = REGIONS.find(
        (p) => p.country === r.country && p.slug === r.parent,
      );
      if (!parent) {
        errors.push(
          `region ${r.country}/${r.slug} has unresolved parent '${r.parent}'`,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`regions catalog invalid:\n  ${errors.join("\n  ")}`);
  }
}
assertCatalogValid();
