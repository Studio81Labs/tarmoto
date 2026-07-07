import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { Poi } from '../../entities/poi.entity.js';
import {
  POI_PROVIDER,
  type PoiProvider,
  type StoredPoiFields,
} from './poi-provider.interface.js';
import { ACCOMMODATION_KINDS } from './dto/accommodation.dto.js';
import { poiImportConfig, type PoiImportConfig } from './poi-import.config.js';
import { withPoiRepo } from './poi-repo.js';

/** Rows per bulk upsert — keeps each statement under PG's param limit. */
const UPSERT_CHUNK = 500;

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

/**
 * The shape `add()` accepts — the common denominator of `ImportedPoi` and
 * `AccommodationPoi & StoredPoiFields`. `stars` is optional (only
 * accommodations carry it); the `StoredPoiFields` columns are optional so a
 * future provider that can't fill them still type-checks.
 */
type StorableImportRow = {
  external_id: string;
  kind: string;
  name: string | null;
  website: string | null;
  phone: string | null;
  lat: number;
  lng: number;
  stars?: number | null;
} & Partial<StoredPoiFields>;

export interface PoiImportResult {
  fetched: number;
  upserted: number;
}

/**
 * Mirrors POIs for a configured area into the `pois` table for offline use
 * (#745). Fetches via the `PoiProvider` (Overpass) and upserts by
 * `(source, external_id)`, so a re-run is idempotent and overwrites in
 * place. The fetch throwing (Overpass down) aborts before any write, so a
 * provider outage never wipes existing rows. Does not delete absent rows —
 * a partial-area response can't blank the table.
 *
 * The POI store's reachability is checked TWICE: once up front, before the
 * Overpass fetch, so a POI-DB outage 503s immediately instead of spending
 * the full request budget on a bbox the weekly cron can't persist (and will
 * retry anyway); and again around the upsert via `withPoiRepo`, in case the
 * store drops between the fetch and the write.
 *
 * The live planner read paths are unchanged (still per-request Overpass);
 * this only populates the store that offline packs / a POI tile layer read.
 */
@Injectable()
export class PoiImportService {
  private readonly logger = new Logger(PoiImportService.name);

  constructor(
    @Inject(POI_PROVIDER)
    private readonly provider: PoiProvider,
    @InjectDataSource('poi')
    private readonly poiDataSource: DataSource,
    @Inject(poiImportConfig.KEY)
    private readonly config: ConfigType<typeof poiImportConfig>,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The bbox the import runs over — exposed so the manual CLI can log it. */
  get bbox(): PoiImportConfig['bbox'] {
    return this.config.bbox;
  }

  /**
   * Fail fast: if the POI store is unreachable, don't spend the Overpass
   * request budget fetching a bbox we can't persist (the weekly cron
   * retries, so a POI-DB outage would otherwise hammer OSM on every tick).
   * A cheap bounded probe (`SELECT 1`) catches a runtime connection drop,
   * not just a cold-start `isInitialized === false`. The `withPoiRepo`
   * upsert below remains the second check, for a drop between here and the
   * write.
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

  async import(): Promise<PoiImportResult> {
    await this.assertStoreReachable();

    // Fetch POIs + accommodations together. Promise.all so a failure on
    // either aborts before any write (the outage-safety contract) rather
    // than half-importing — and the accommodation kinds reuse the
    // `/accommodations` contract so the offline store can't drop hotels
    // / campsites.
    const [pois, accommodations] = await Promise.all([
      this.provider.findImportPoisInBbox(this.config.bbox),
      this.provider.findAccommodationsInBbox(this.config.bbox, [
        ...ACCOMMODATION_KINDS,
      ]),
    ]);

    const batchTime = new Date();
    // Dedupe by external id (a duplicate id in one snapshot would make a
    // single upsert touch the same row twice and abort the batch).
    const byExternalId = new Map<string, QueryDeepPartialEntity<Poi>>();
    const add = (p: StorableImportRow): void => {
      byExternalId.set(p.external_id, {
        source: 'osm',
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
      });
    };
    for (const p of pois) add(p);
    for (const a of accommodations) add(a);
    const rows = [...byExternalId.values()];

    // Resolve (and readiness-check) the repo once, unconditionally, so an
    // unavailable POI store surfaces a 503 even when this snapshot has no
    // rows to write (an empty chunk loop would otherwise never touch it).
    await withPoiRepo(this.poiDataSource, async (repo) => {
      for (const part of chunk(rows, UPSERT_CHUNK)) {
        if (part.length) {
          await repo.upsert(part, {
            conflictPaths: ['source', 'external_id'],
          });
        }
      }
    });

    const fetched = pois.length + accommodations.length;
    this.logger.log(
      `POI import (osm): fetched=${fetched} ` +
        `(poi=${pois.length} accommodation=${accommodations.length}) ` +
        `upserted=${rows.length}`,
    );
    return { fetched, upserted: rows.length };
  }
}
