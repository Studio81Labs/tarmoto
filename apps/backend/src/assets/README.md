# `import-region-boundaries.geojson` (#944)

Committed GeoJSON boundary polygons for the countries the POI bulk importer
covers, used by `poi_import_regions` (geometry-membership coverage) instead of
the old point-proximity buffer. Loaded once by a later migration/script — the
running backend never fetches this over the network.

## Source

- **Natural Earth 1:50m admin-0 countries**, via the public GitHub mirror
  [`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector):
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson`
- Repo `VERSION` at generation time: `5.2.0-pre`. The countries file itself was
  last content-changed upstream at commit `9380cca8` (2022-05-13) — country
  borders at 1:50m resolution are stable, so a stale mirror commit doesn't mean
  stale data.
- **Licence: public domain.** Natural Earth's `LICENSE.md`: "Everything here is
  public domain. ... No permission is needed to use Natural Earth. Crediting
  the authors is unnecessary." No attribution obligation, unlike the OSM/FSQ
  POI sources this repo already credits elsewhere.

## Filtering + code mapping

Filtered to the codes in `DEFAULT_REGIONS` (`packages/ingest/src/poi/regions.ts`),
matched against each Natural Earth feature's `ISO_A2` property, **falling back
to `ISO_A2_EH`** (the "de-facto" / on-the-ground ISO code variant Natural Earth
ships for disputed territories) when `ISO_A2 === '-99'` (Natural Earth's sentinel
for "not applicable"). This repo's set needed the fallback for at least Kosovo
(`XK`), which some Natural Earth releases carry as `-99` under `ISO_A2` and only
resolve under `ISO_A2_EH`.

Every geometry is normalized to `MultiPolygon` (a plain `Polygon` is wrapped as
a single-element `MultiPolygon`) so `poi_import_regions.geom` has one consistent
column type regardless of whether the source country is a single landmass or
an archipelago.

## Regenerating

The asset is derived, not authored — never hand-edit it. To regenerate:

```bash
node apps/backend/src/scripts/derive-region-boundaries.mjs
```

The generator (`derive-region-boundaries.mjs`) re-derives the target codes from
`regions.ts` via a regex over the source text (rather than importing
the TS module from a `.mjs` script), so the asset can never silently drift from
`DEFAULT_REGIONS` — add or remove a region there and regenerating picks it up
automatically. It asserts every derived code resolves to a Natural Earth
polygon and throws if one is missing, rather than silently shipping a gap.
Commit the regenerated file alongside the config change that prompted it.

## Current contents

`DEFAULT_REGIONS` currently lists **17** codes (not 18 — some earlier planning
notes for #944 assumed 18; the live config only has 17 entries as of this
commit, and this asset intentionally tracks the config, not the planning
estimate). All 17 resolved to a Natural Earth polygon on the last generation:

`AL, AT, BA, BG, CZ, DE, GR, HR, IT, ME, MK, PL, RO, RS, SI, SK, XK`

The output is ~104 KB (17 mostly small-to-medium European/Balkan countries at
1:50m resolution — an earlier size estimate of ~1–2 MB assumed either more
countries or coarser generalization; the smaller size reflects real geometry
complexity, e.g. Greece's ~40 island rings dominate the byte count while
landlocked single-ring countries like Kosovo or Montenegro are a couple KB
each). If `DEFAULT_REGIONS` grows to include larger/more complex countries, a
regenerated file will grow accordingly — there's no fixed size expectation to
maintain.
