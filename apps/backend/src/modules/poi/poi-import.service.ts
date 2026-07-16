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
import { Poi } from '@tarmoto/poi-db';
import { poiImportConfig } from './poi-import.config.js';
import {
  OsmPoiImportSource,
  POI_IMPORT_SOURCE,
  poiAdvisoryLockKey,
  type PoiImportRegion,
  type PoiImportSource,
  type StorableImportRow,
} from '@tarmoto/ingest';
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

/**
 * `PoiImportResult.warning` text for the tombstone wipe-guard's partial-accept
 * path (below). Exported (rather than inlined at the one return site that
 * sets it) so tests here and in `poi-import-run.recorder.spec.ts` can assert
 * against the same constant instead of a duplicated string literal that could
 * silently drift from it.
 */
export const WIPE_GUARD_WARNING =
  'extract looks incomplete — tombstone + coverage stamp withheld (wipe-guard); rebuild the extract';

/**
 * Fixed namespace for the per-(source, region) advisory lock (#847) that
 * serializes a manual admin trigger against the weekly cron on the same
 * region — `pg_try_advisory_lock(ns, key)`'s first arg, scoping these locks
 * away from any other 2-int advisory lock the app might add later. Arbitrary
 * but stable across the process ('POI\x01' packed into an int32).
 */
const LOCK_NAMESPACE = 0x504f_4901;

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
  /**
   * Operator-actionable reason the region was skipped this run — null
   * whenever `skipped` is not true. Carries the REAL, path-specific cause
   * (e.g. "no extract file at <path>" vs. "extract yielded 0 in-bbox rows")
   * so `PoiImportRunRecorder.finish` can persist it verbatim instead of
   * synthesizing one generic message that can't tell a missing-extract/
   * storage gap (needs an upload) from a zero-row gap (needs the extract
   * rebuilt) apart (#847 review).
   *
   * NOTE: the tombstone wipe-guard (`wouldWipeTooMuch` below) does NOT set
   * `skipped: true` — it still upserts the incoming rows and only withholds
   * the tombstone + coverage-stamp sub-steps, so that run is a genuine
   * (partial) success, not a skip, and falls through to the `skipReason:
   * null` return like any other successful import — flagged instead via
   * `warning` below.
   */
  skipReason: string | null;
  /**
   * Operator-actionable advisory for a run that completed as a genuine
   * `success` (never `skipped`) but withheld part of its normal work — null
   * on every clean success AND on both skip paths above. The only producer
   * today is the tombstone wipe-guard partial-accept path
   * (`wouldWipeTooMuch` below): the incoming rows were upserted, but
   * tombstoning (and, for OSM, the coverage stamp) were withheld because the
   * extract looks incomplete. `PoiImportRunRecorder.finish` persists this
   * verbatim into `poi_import_runs.warning` so the admin Runs panel can flag
   * a run that upserted cleanly yet isn't a fully-trustworthy replacement of
   * the region's prior extract — distinct from `skipReason`, which only ever
   * fires when NO upsert happened at all.
   */
  warning: string | null;
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

  /**
   * Whether this source's extract directory is configured (its
   * `TARMOTO_*_IMPORT_DIR` is set). When false, `getExtractPath` throws — the
   * admin upload route checks this to return a clear 503 rather than a 500 (#847).
   */
  get extractDirConfigured(): boolean {
    return this.config.extractDir !== null;
  }

  /**
   * Public accessor for a configured region's resolved extract path (#847
   * admin status read — `PoiImportAdminService.listRegionStatus` stats this
   * path per region to report whether an extract has been uploaded yet).
   * Delegates to the same resolver `importRegionBody` uses internally, so
   * `<extractDir>/<code>.osm` (or `.fsq.jsonl` for the FSQ strategy) stays
   * defined in exactly one place. Throws under the same conditions as the
   * private resolver below (`extractDir` unset), and also for a code outside
   * this instance's configured `regions` — the admin read wraps the call in
   * a try/catch and reports `extract: null` rather than a 500 for an
   * unconfigured or not-yet-provisioned region.
   */
  getExtractPath(code: string): string {
    const region = this.config.regions.find((r) => r.code === code);
    if (!region) {
      throw new Error(`Unknown POI import region code: ${code}`);
    }
    return this.extractPath(region);
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

    // Serialize same-(source, region) imports (#847): a manual admin trigger
    // must not race the weekly cron importing the same region. A PostgreSQL
    // SESSION advisory lock (`pg_try_advisory_lock` / `pg_advisory_unlock`) is
    // held by the specific DB CONNECTION that acquired it — issuing the lock
    // and the unlock as two separate calls through the pooled `poiDataSource`
    // risks the pool handing them to two DIFFERENT connections, which would
    // run the unlock on a connection that never held the lock and leak the
    // lock forever (it would then never release until that connection is
    // torn down). A dedicated QueryRunner pins ONE connection for exactly
    // this lock/unlock pair. `importRegionBody` below does NOT need `runner`
    // — it's free to use the pool as before (`withPoiRepo`); serialization
    // comes from a concurrent same-(source, region) caller failing ITS OWN
    // `pg_try_advisory_lock` call on ITS OWN runner, not from which
    // connection does the writing.
    const key = poiAdvisoryLockKey(this.source, region.code);
    const runner = this.poiDataSource.createQueryRunner();
    await runner.connect();
    try {
      // `QueryRunner.query` (unlike `EntityManager.query`) has no generic
      // overload in this TypeORM version — it always returns `Promise<any>` —
      // so the shape is asserted on the result instead.
      const got = (await runner.query(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [LOCK_NAMESPACE, key],
      )) as { locked: boolean }[];
      if (!got?.[0]?.locked) {
        throw new Error(
          `POI import for ${this.source}/${region.code} is already running — retry later`,
        );
      }
      try {
        return await this.importRegionBody(region);
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1, $2)', [
          LOCK_NAMESPACE,
          key,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * The parse + upsert + tombstone body, run while `importRegion` holds the
   * per-(source, region) advisory lock (see there for why the lock needs a
   * pinned connection). Split out purely so that lock/unlock wrapper doesn't
   * force re-indenting this whole (already long) method.
   */
  private async importRegionBody(
    region: PoiImportRegion,
  ): Promise<PoiImportResult> {
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
        skipReason: `no extract file at ${path}`,
        warning: null,
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
    // Set inside the transaction below, from the same `wouldWipeTooMuch` the
    // tombstone/coverage steps already gate on — read back after the
    // transaction to build the final result's `warning` (#847 review).
    let wipeGuardTripped = false;

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
        skipReason: `extract yielded 0 in-bbox rows (fetched=${fetched})`,
        warning: null,
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
        wipeGuardTripped = wouldWipeTooMuch;

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

        // 4. Stamp the region as genuinely imported — the signal geometry-
        // membership coverage keys off (`WHERE imported_at IS NOT NULL`, #944).
        // A real upsert just happened (neither skip path was taken).
        //
        // BUT NOT when the wipe guard tripped (#944 review): coverage marks the
        // WHOLE region authoritative, so an INCOMPLETE extract would let
        // `readStoreFirst` skip Overpass across the slices this run never loaded.
        // `wouldWipeTooMuch` is exactly the "this extract looks incomplete"
        // suspicion, so we must not (re-)stamp coverage off it — the region keeps
        // whatever `imported_at` a prior COMPLETE import gave it (still covered),
        // or stays uncovered until a complete import lands (Overpass keeps
        // serving it). When the stamp does fire it shares the upsert's `tx`, so it
        // commits atomically.
        //
        // OSM-only: the coverage query this feeds gates the OSM Overpass fallback
        // (`source = 'osm'`, `PoiStoreService`), so an FSQ run must never stamp —
        // it would wrongly suppress the OSM fallback for a region OSM never loaded.
        if (this.importSource.source === 'osm' && !wouldWipeTooMuch) {
          // `RETURNING` surfaces the silent no-op (#978): this is an
          // existing-row-only UPDATE, so a region whose boundary polygon was
          // never loaded (`poi:load-boundaries` not run before the import)
          // matches 0 rows — the POIs upsert fine, but the region would read
          // "not covered" forever. Warn instead of dropping coverage silently;
          // the import still commits (the upserted rows are valid — a re-import
          // after loading boundaries stamps it).
          const stamped: { code: string }[] = await tx.query(
            `UPDATE "poi_import_regions" SET "imported_at" = now() WHERE "code" = $1 RETURNING "code"`,
            [region.code],
          );
          if (stamped.length === 0) {
            this.logger.warn(
              `POI import (${region.code}): coverage NOT stamped — no ` +
                `"poi_import_regions" row for this code. Run "poi:load-boundaries" ` +
                `before importing (it seeds the region polygons), then re-import ` +
                `to stamp coverage; until then the region reads as "not covered" ` +
                `despite the upsert.`,
            );
          }
        } else if (this.importSource.source === 'osm') {
          this.logger.warn(
            `POI import (${region.code}): extract looks incomplete ` +
              `(wipe guard tripped) — NOT stamping coverage; the region keeps ` +
              `its prior coverage state`,
          );
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
      skipReason: null,
      warning: wipeGuardTripped ? WIPE_GUARD_WARNING : null,
    };
  }
}
