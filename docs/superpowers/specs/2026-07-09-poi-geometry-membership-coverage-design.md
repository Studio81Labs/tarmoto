# Geometry-membership POI coverage — design (#944)

**Goal:** Replace point-proximity POI coverage with region-polygon membership, so
the store-first read's "is this request inside imported territory?" decision is
exact (to the polygon's precision) instead of over-claiming a ~20 km border halo.

**Issue:** #944 — follow-up to #940 / #925.

## Background

`PoiStoreService` decides whether an empty/partial store result is authoritative
(skip Overpass) or a frontier that must merge Overpass. #940 shipped that as an
occupancy probe: "an imported OSM point exists within `COVERAGE_BUFFER_KM` (20 km)
of every sample spanning the request geometry." Proximity is only an approximation
of membership — it reports covered up to one buffer _outside_ the true import
boundary (the border halo), and the sampling needed a long tail of geometric
guards (rim/rail points, stride/overlap, chunking, WGS84 clamping, degenerate
routes). Real region polygons make the question exact and delete that machinery.

The halo only bites during a **partial rollout** (some countries imported,
neighbours not) and self-heals at full-continent import; membership removes it
outright.

## Global constraints

- Boundary source: **Natural Earth 1:50m admin-0**, public domain, keyed by ISO
  3166-1 alpha-2 — the same codes `pois.import_region` / `DEFAULT_REGIONS.code`
  use. Filtered to the 17 `DEFAULT_REGIONS` codes; committed as a GeoJSON asset
  (~104 KB) directly in the repo.
- Lives in the **POI DB** (the separate PostGIS datasource, `@InjectDataSource('poi')`),
  alongside `pois`. Schema via a `migrations-poi` migration (migrations here are
  schema-only; data loads via a script).
- No new TypeORM entity — coverage is raw SQL, avoiding the data-source vs
  `database.module` entity-registration split.
- Metric only server-side; geometries are SRID 4326.

## Architecture

Coverage becomes a single PostGIS containment test: **is the buffered request
geometry (disc or corridor) fully covered by the polygon of a region that has
been imported?**

```
readStoreFirst(fromStore, fromProvider, coverageDescriptor?)
  descriptor = { kind: 'radius', lat, lng, radiusKm }
             | { kind: 'route',  route: {lat,lng}[], bufferKm }
  → PoiStoreService.isRequestCovered(descriptor): boolean
      SELECT EXISTS (
        SELECT 1 FROM poi_import_regions r
        WHERE r.imported_at IS NOT NULL
          AND ST_Covers(r.geom, ST_Buffer(<request>::geography, <bufferMeters>)::geometry)
      )
```

- `<request>` for `radius` = `ST_SetSRID(ST_MakePoint($lng,$lat),4326)`, buffered by
  `radiusKm`.
- `<request>` for `route` = `ST_SetSRID(ST_GeomFromGeoJSON($lineGeoJSON),4326)`
  (one text param — no per-vertex param explosion), buffered by `bufferKm`. The
  builder emits the GeoJSON `LineString` with **`[lng, lat]`** coordinate order
  (GeoJSON is lng-first, our route points are `{lat, lng}` — do not swap). A
  degenerate zero-length route yields a valid `LineString`/`Point` that buffers to
  the same disc the store's `ST_DWithin` corridor produces, so no special-case is
  needed.
- Fully inside a single imported country → covered. Straddling the import frontier
  (imported ↔ un-imported) → not covered → Overpass merge. Straddling two imported
  countries → not covered by a single polygon → merge (harmless extra Overpass;
  accepted, see Non-goals).

## Components

### 1. `poi_import_regions` table + migration

`migrations-poi/<ts>-AddPoiImportRegions.ts`:

```sql
CREATE TABLE poi_import_regions (
  code        varchar(2) PRIMARY KEY,
  geom        geometry(MultiPolygon, 4326) NOT NULL,
  imported_at timestamptz NULL
);
CREATE INDEX poi_import_regions_geom_gix ON poi_import_regions USING GIST (geom);
```

`down` drops the index + table.

### 2. Boundary asset + loader

- Asset: `apps/backend/src/assets/import-region-boundaries.geojson` — a
  FeatureCollection of the 17 `DEFAULT_REGIONS` countries (ISO A2 → MultiPolygon),
  derived from Natural Earth 1:50m admin-0. A short, documented derivation note
  records how it was filtered/simplified (reproducible, not a black box). The
  derivation maps each feature to its ISO alpha-2 via Natural Earth's `ISO_A2`
  field, falling back to `ISO_A2_EH` where `ISO_A2` is `-99` (Natural Earth marks
  a few sovereignties that way) — the 17 targets are all clean ISO A2, and the
  loader asserts every `DEFAULT_REGIONS` code is present so a missing/misspelled
  code fails loudly at load time rather than silently never covering.
- Loader: `apps/backend/src/scripts/load-region-boundaries.ts`, wired as
  `pnpm poi:load-boundaries`. Reads the asset and upserts each feature:
  `INSERT ... (code, geom) VALUES ($1, ST_GeomFromGeoJSON($2)) ON CONFLICT (code)
DO UPDATE SET geom = EXCLUDED.geom` — leaves `imported_at` untouched on update
  so an already-imported region stays covered. Idempotent; run on setup and when
  the asset changes.

### 3. Importer `imported_at` stamp

`PoiImportService.importRegion`, on a successful (non-skipped) **OSM** import (`importSource.source === 'osm'`), runs
`UPDATE poi_import_regions SET imported_at = now() WHERE code = $1`. This is the
"region is imported" signal — a region's polygon only counts once its country has
actually been imported, so an un-imported neighbour whose polygon is loaded never
falsely covers. A region row missing from `poi_import_regions` (asset not loaded)
simply can't be stamped and never covers → safe.

### 4. Coverage query — `isRequestCovered(descriptor)`

Replaces `hasImportedCoverage(samples)`. Builds the containment SQL above.
Coordinates are validated (finite; the geography cast rejects out-of-range, so
reject/skip a non-finite descriptor → not covered rather than 500). A transient
POI-store outage during the lookup resolves to `false` (= not covered → merge
Overpass), exactly as today; a real defect surfaces.

### 5. `readStoreFirst` + callers

`readStoreFirst`'s third argument changes from `coverageSamples` to a
`coverageDescriptor`. Callers pass:

- nearby / accommodations: `{ kind: 'radius', lat, lng, radiusKm: radius }`
- along-route: `{ kind: 'route', route: dto.route, bufferKm }`

The covered / merge / empty→Overpass branching is unchanged.

### 6. Removals

Obsolete once membership lands — delete with their tests:
`radiusCoverageSamples`, `routeCoverageSamples`, `segGeom`/`offsetKm` helpers,
`coverageChunkQuery`, the chunk loop, `MAX_COVERAGE_SAMPLES`, `COVERAGE_BUFFER_KM`,
the WGS84 clamp, degenerate-route handling. `padBbox` / `Bbox` stay only if still
used elsewhere (checked during implementation; else removed).

## Data flow

1. Deploy: migration creates the table; `pnpm poi:load-boundaries` loads the 17
   polygons (`imported_at` NULL).
2. Import: an OSM `poi:import` writes `pois` rows for a region AND stamps its
   `imported_at` (FSQ imports do NOT stamp — coverage suppresses the OSM fallback).
3. Read: `readStoreFirst` builds a descriptor → `isRequestCovered` → `ST_Covers`
   against imported-region polygons → covered (store authoritative) or not
   (Overpass merge).

## Error handling

- Polygons not loaded / region not stamped → `EXISTS` is false → not covered →
  Overpass (safe, pre-#925 behaviour).
- Non-finite / malformed descriptor → not covered (never 500).
- POI-store outage during lookup → not covered (merge), same as #940.
- Loader on a missing/invalid asset → fails loudly (a real setup error), does not
  silently leave coverage empty beyond logging.

## Testing

- **Unit** (`isRequestCovered` SQL builder, mocked query): radius vs route SQL
  shape and params (single text param for the route line); the
  `imported_at IS NOT NULL` filter present; a non-finite descriptor short-circuits
  to false without a query.
- **Unit** (loader): parses the asset, upserts per feature, `ON CONFLICT` keeps
  `imported_at`.
- **Integration** (real PostGIS, existing poi e2e/integration harness): point
  inside CZ's polygon → covered; point in the DE/AT/PL wedge that sits inside CZ's
  bounding box but outside CZ's polygon → **not** covered (the halo is gone); a
  route crossing CZ → un-imported country → not covered; a fully-in-CZ route →
  covered; boundary-loader idempotency + `imported_at` preserved on re-load.
- Regression: the DE-wedge case is the concrete halo the old proximity probe got
  wrong.

## Non-goals / accepted limitations

- A request straddling **two imported** countries isn't covered by a single
  polygon → an extra (harmless) Overpass merge. A `ST_Union` of imported polygons
  would fix it but is expensive per query; not worth it (rare, non-regressive).
- A **truncated/partial** re-import is caught: the importer's `wouldWipeTooMuch`
  wipe guard already flags an extract that looks incomplete (it would tombstone an
  implausible share of the region), and the `imported_at` stamp is gated on
  `!wouldWipeTooMuch` (#944 review) — a suspect re-import does NOT (re-)stamp
  coverage; the region keeps whatever a prior complete import gave it, or stays
  uncovered. The residual is a **first** import with no baseline (a corrupt
  first extract with a handful of rows): there is no in-process completeness
  oracle for it (a row-count floor is defeated by a city-scoped extract, as #925
  showed), so it stays an operational concern (importer fetched/upserted counts)
  and self-heals on the next baseline-having run.
- The dense-frontier merge cap-starvation (#945) is orthogonal and still applies.
