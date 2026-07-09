import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { Poi } from '../../entities/poi.entity.js';
import { poiImportConfig, type PoiImportRegion } from './poi-import.config.js';
import {
  OsmPoiImportSource,
  POI_IMPORT_SOURCE,
  type PoiImportSource,
  type StorableImportRow,
} from './poi-import-source.js';
import { withPoiRepo } from './poi-repo.js';

/**
 * DI token for the Foursquare `PoiImportService` instance (#869) — a second
 * instance of this service bound to the FSQ source + `fsqImportConfig`, wired
 * via a factory in `PoiModule`. The default class provider stays OSM, so
 * `app.get(PoiImportService)` / the OSM cron are unchanged.
 */
export const FSQ_POI_IMPORT = Symbol('FSQ_POI_IMPORT');

/**
 * DI token for the ordered registry of bulk import sources (#869) — every
 * `PoiImportService` instance (OSM, FSQ, …) the weekly dispatcher fans out over.
 * `PoiModule` binds it to `[PoiImportService (OSM), FSQ_POI_IMPORT (FSQ)]`;
 * adding a third source later is one more entry here, with no processor change.
 * Each instance self-identifies via `source` and gates on its own `enabled`, so
 * the fan-out runs exactly the sources whose `TARMOTO_*_IMPORT_ENABLED` is set.
 */
export const POI_IMPORT_SOURCES = Symbol('POI_IMPORT_SOURCES');

/** Rows per bulk upsert — keeps each statement under PG's param limit. */
const UPSERT_CHUNK = 500;

/**
 * Tombstone safety-valve: refuse a run that would soft-deactivate more than this
 * fraction of a region's own rows. A valid-but-incomplete extract (wrong
 * tags-filter, wrong country file clipped to the bbox, truncated output) can
 * carry a few in-bbox rows and slip past the zero-rows check, then tombstone
 * most of the region — a real week never closes half a country's POIs. Only
 * applied once the region holds at least `MIN_REGION_FOR_TOMBSTONE_GUARD` rows,
 * since small regions have noisy churn ratios.
 */
const MAX_TOMBSTONE_FRACTION = 0.5;
const MIN_REGION_FOR_TOMBSTONE_GUARD = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** `pois` text-column widths — truncate to these so an over-long OSM tag
 * (e.g. a semicolon-separated phone list) can never fail the upsert. */
const COLUMN_LIMITS = {
  name: 255,
  website: 512,
  phone: 255,
  opening_hours: 512,
  address_street: 255,
  address_city: 128,
  address_postcode: 32,
  cuisine: 128,
  brand: 128,
} as const;

function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export interface PoiImportResult {
  /** ISO country code of the region this result covers. */
  region: string;
  fetched: number;
  upserted: number;
  tombstoned: number;
  /**
   * True when the region was not imported this run — either no extract file yet
   * (gradual provisioning) or a valid-but-empty extract we refused to let wipe
   * the region.
   */
  skipped?: boolean;
}

/**
 * Mirrors bulk POI extracts into the `pois` table for offline use (#745),
 * scaled to continent coverage in #850. Source-agnostic: the per-source
 * strategy ({@link PoiImportSource}) supplies the `source` string, the extract
 * filename, and the parser, while this service owns the source-neutral core
 * (bbox filter, dedupe, the upsert + bbox-bounded tombstone, the safety
 * guards). The default is OSM/Geofabrik `.osm` extracts the operator produces
 * with `osmium tags-filter` (see the runbook); #869 adds Foursquare OS Places
 * as a second `source`. Overpass stays the live read-path fallback
 * (`poi.service`), not the importer.
 *
 * Per region:
 *  - parse the whole extract **before any write** (a parse failure aborts
 *    before a single statement, so a bad extract never wipes existing rows);
 *  - upsert by `(source, external_id)` — idempotent, and it clears
 *    `deactivated_at`, so a reopened venue that reappears is revived;
 *  - **stale-by-absence tombstoning bounded by the region's bbox**: rows inside
 *    the bbox that are absent from the extract are soft-tombstoned (an UPDATE of
 *    `deactivated_at`, never a DELETE), while rows outside the bbox are never
 *    loaded and so never touched. This mirrors the roads importer's contract.
 *
 * The POI store's reachability is checked up front (a cheap `SELECT 1`) so a
 * POI-DB outage 503s immediately instead of parsing an extract it can't persist,
 * and again around the write via `withPoiRepo`.
 */
@Injectable()
export class PoiImportService {
  private readonly logger = new Logger(PoiImportService.name);

  constructor(
    @InjectDataSource('poi')
    private readonly poiDataSource: DataSource,
    @Inject(poiImportConfig.KEY)
    private readonly config: ConfigType<typeof poiImportConfig>,
    // The per-source strategy: filename + parser + `source` string. Optional so
    // the default provider + the existing tests get OSM with no wiring; the FSQ
    // instance is constructed with its own source + config.
    @Optional()
    @Inject(POI_IMPORT_SOURCE)
    private readonly importSource: PoiImportSource = new OsmPoiImportSource(),
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * The source string this instance imports (`osm` / `fsq`) — from its strategy.
   * The registry fan-out stamps it on each region job so the worker routes the
   * job back to the right importer, and it scopes the job id + logs per source.
   */
  get source(): string {
    return this.importSource.source;
  }

  /** The configured coverage list — the dispatcher fans out one job per entry. */
  get regions(): readonly PoiImportRegion[] {
    return this.config.regions;
  }

  /** Resolve a region's extract path: `<extractDir>/<source filename>`. */
  private extractPath(region: PoiImportRegion): string {
    if (!this.config.extractDir) {
      throw new Error(
        'POI import is enabled but TARMOTO_POI_IMPORT_DIR is not set',
      );
    }
    return join(
      this.config.extractDir,
      this.importSource.extractFilename(region),
    );
  }

  /**
   * Fail fast: if the POI store is unreachable, don't parse a large extract we
   * can't persist (the weekly job retries, so a POI-DB outage would otherwise
   * re-parse on every tick). A bounded `SELECT 1` catches a runtime drop, not
   * just a cold-start `isInitialized === false`. `withPoiRepo` around the write
   * is the second check, for a drop between here and the upsert.
   */
  private async assertStoreReachable(): Promise<void> {
    try {
      if (!this.poiDataSource.isInitialized) {
        throw new Error('poi store not initialized');
      }
      await this.poiDataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException(
        'POI store is temporarily unavailable',
      );
    }
  }

  /** Import every configured region sequentially (CLI / non-fan-out path). */
  async importAll(): Promise<PoiImportResult[]> {
    const results: PoiImportResult[] = [];
    for (const region of this.config.regions) {
      results.push(await this.importRegion(region));
    }
    return results;
  }

  async importRegion(region: PoiImportRegion): Promise<PoiImportResult> {
    await this.assertStoreReachable();

    const path = this.extractPath(region);
    if (!existsSync(path)) {
      // A configured region without an extract yet — skip (with a clear log)
      // rather than fail, so provisioning can roll out country-by-country.
      this.logger.warn(
        `POI import (${region.code}): no extract at ${path}, skipping`,
      );
      return {
        region: region.code,
        fetched: 0,
        upserted: 0,
        tombstoned: 0,
        skipped: true,
      };
    }

    const { bbox } = region;
    const inBbox = (lng: number, lat: number): boolean =>
      lng >= bbox.minLng &&
      lng <= bbox.maxLng &&
      lat >= bbox.minLat &&
      lat <= bbox.maxLat;

    const batchTime = new Date();
    // Dedupe by external id (parsePoiExtract does not dedupe — a duplicate id in
    // one extract would otherwise make a single upsert touch the same row twice
    // and abort the batch). Buffering the whole (tag-filtered) extract before
    // any write is the outage-safety contract: a parse throw aborts here.
    const byExternalId = new Map<string, QueryDeepPartialEntity<Poi>>();
    const add = (p: StorableImportRow): void => {
      byExternalId.set(p.external_id, {
        source: this.importSource.source,
        external_id: p.external_id,
        kind: p.kind,
        name: clamp(p.name, COLUMN_LIMITS.name),
        website: clamp(p.website, COLUMN_LIMITS.website),
        phone: clamp(p.phone, COLUMN_LIMITS.phone),
        opening_hours: clamp(
          p.opening_hours ?? null,
          COLUMN_LIMITS.opening_hours,
        ),
        address_street: clamp(
          p.address_street ?? null,
          COLUMN_LIMITS.address_street,
        ),
        address_city: clamp(p.address_city ?? null, COLUMN_LIMITS.address_city),
        address_postcode: clamp(
          p.address_postcode ?? null,
          COLUMN_LIMITS.address_postcode,
        ),
        // Already normalized to a 2-char ISO code upstream — no clamp needed.
        address_country: p.address_country ?? null,
        cuisine: clamp(p.cuisine ?? null, COLUMN_LIMITS.cuisine),
        brand: clamp(p.brand ?? null, COLUMN_LIMITS.brand),
        stars: p.stars ?? null,
        tags: p.tags ?? null,
        geom: { type: 'Point', coordinates: [p.lng, p.lat] },
        last_imported_at: batchTime,
        // Revive: a re-import of a previously-tombstoned (reopened) venue
        // clears the tombstone via this upsert.
        deactivated_at: null,
        // Region ownership — the tombstone pass only considers rows this region
        // imported, so overlapping border bboxes can't tombstone a neighbour.
        import_region: region.code,
      });
    };

    let fetched = 0;
    const stream = createReadStream(path);
    for await (const row of this.importSource.parse(stream)) {
      fetched += 1;
      // Drop extract overhang: only rows whose point falls inside the region's
      // authoritative bbox count — so the tombstone pass (bounded to the same
      // bbox) can never wrongly delete a neighbour the extract clipped in.
      if (!inBbox(row.lng, row.lat)) continue;
      add(row);
    }

    const rows = [...byExternalId.values()];
    const incomingIds = new Set(byExternalId.keys());
    let tombstoned = 0;

    // Guard against a broken extract wiping a region: a valid-but-empty file
    // (`<osm/>`, a failed `osmium tags-filter`, or points all outside the bbox)
    // yields zero in-bbox rows, and the tombstone pass would then soft-deactivate
    // every row the region owns. Skip the write and log — a real country never
    // has zero POIs, so zero means the extract is wrong, not that everything
    // closed. (An empty extract for a not-yet-imported region is a harmless
    // no-op here too.)
    if (rows.length === 0) {
      this.logger.warn(
        `POI import (${region.code}): extract yielded 0 in-bbox rows ` +
          `(fetched=${fetched}) — skipping upsert + tombstone to avoid wiping ` +
          `the region`,
      );
      return {
        region: region.code,
        fetched,
        upserted: 0,
        tombstoned: 0,
        skipped: true,
      };
    }

    await withPoiRepo(this.poiDataSource, async (repo) => {
      await repo.manager.transaction(async (tx) => {
        // 1. Load the region's live rows BEFORE upserting, so both the tombstone
        // candidate set and the wipe-guard denominator reflect the PRE-import
        // region — not inflated by the incoming rows the upsert is about to add
        // (else a wrong extract of ~N fresh ids against N existing rows would
        // double the denominator and slip the guard). Load rows THIS region
        // imported (`import_region`) OR unclaimed (`import_region` null — legacy
        // pre-#850 Overpass rows the migration couldn't attribute). The region
        // scope is load-bearing: the default bboxes overlap at borders, so a
        // bbox-only load would let e.g. the SK job tombstone live Czech border
        // POIs absent from SK's extract. A legacy (null) row is only THIS
        // region's to tombstone when no OTHER configured region's bbox contains
        // it — otherwise it's an ambiguous border row, left for whichever
        // region's extract actually claims it (present rows get an
        // `import_region` via the upsert below; only closed legacy rows remain).
        const existing = await tx.query<
          {
            id: string;
            external_id: string;
            lng: number;
            lat: number;
            import_region: string | null;
          }[]
        >(
          `SELECT id, external_id, ST_X(geom) AS lng, ST_Y(geom) AS lat, import_region
             FROM pois
             WHERE source = $6 AND deactivated_at IS NULL
               AND (import_region = $5 OR import_region IS NULL)
               AND geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
          [
            bbox.minLng,
            bbox.minLat,
            bbox.maxLng,
            bbox.maxLat,
            region.code,
            this.importSource.source,
          ],
        );

        const otherRegions = this.config.regions.filter(
          (r) => r.code !== region.code,
        );
        const ownedByRegion = (row: {
          lng: number;
          lat: number;
          import_region: string | null;
        }): boolean =>
          row.import_region === region.code ||
          (row.import_region === null &&
            !otherRegions.some(
              (r) =>
                row.lng >= r.bbox.minLng &&
                row.lng <= r.bbox.maxLng &&
                row.lat >= r.bbox.minLat &&
                row.lat <= r.bbox.maxLat,
            ));

        const owned = existing.filter(ownedByRegion);
        const tombstoneIds = owned
          .filter((e) => !incomingIds.has(e.external_id))
          .map((e) => e.id);

        // Near-empty guard: a valid-but-incomplete extract with a few in-bbox
        // rows slips past the zero-rows check but would still tombstone most of
        // the pre-import region — refuse to deactivate an implausible share in
        // one run.
        const wouldWipeTooMuch =
          owned.length >= MIN_REGION_FOR_TOMBSTONE_GUARD &&
          tombstoneIds.length > owned.length * MAX_TOMBSTONE_FRACTION;

        // 2. Upsert (insert new + revive/refresh existing) in param-safe chunks.
        for (const part of chunk(rows, UPSERT_CHUNK)) {
          if (part.length) {
            await tx.getRepository(Poi).upsert(part, {
              conflictPaths: ['source', 'external_id'],
            });
          }
        }

        // 3. Tombstone the stale set (pre-import rows absent from the extract,
        // untouched by the upsert), unless it would wipe an implausible share.
        if (wouldWipeTooMuch) {
          this.logger.warn(
            `POI import (${region.code}): extract would tombstone ` +
              `${tombstoneIds.length}/${owned.length} owned rows ` +
              `(> ${Math.round(MAX_TOMBSTONE_FRACTION * 100)}%) — skipping ` +
              `tombstone; the extract looks incomplete`,
          );
        } else if (tombstoneIds.length > 0) {
          await tx.query(
            `UPDATE pois SET deactivated_at = NOW()
               WHERE id = ANY($1) AND deactivated_at IS NULL`,
            [tombstoneIds],
          );
          tombstoned = tombstoneIds.length;
        }
      });
    });

    this.logger.log(
      `POI import (${region.code}): fetched=${fetched} ` +
        `upserted=${rows.length} tombstoned=${tombstoned}`,
    );
    return {
      region: region.code,
      fetched,
      upserted: rows.length,
      tombstoned,
    };
  }
}
