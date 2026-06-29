import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { Poi } from '../../entities/poi.entity.js';
import { POI_PROVIDER, type PoiProvider } from './poi-provider.interface.js';
import { ACCOMMODATION_KINDS } from './dto/accommodation.dto.js';
import { poiImportConfig } from './poi-import.config.js';

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
const COLUMN_LIMITS = { name: 255, website: 512, phone: 255 } as const;

function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

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
 * The live planner read paths are unchanged (still per-request Overpass);
 * this only populates the store that offline packs / a POI tile layer read.
 */
@Injectable()
export class PoiImportService {
  private readonly logger = new Logger(PoiImportService.name);

  constructor(
    @Inject(POI_PROVIDER)
    private readonly provider: PoiProvider,
    @InjectRepository(Poi)
    private readonly repo: Repository<Poi>,
    @Inject(poiImportConfig.KEY)
    private readonly config: ConfigType<typeof poiImportConfig>,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async import(): Promise<PoiImportResult> {
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
    const add = (p: {
      external_id: string;
      kind: string;
      name: string | null;
      website: string | null;
      phone: string | null;
      lat: number;
      lng: number;
    }): void => {
      byExternalId.set(p.external_id, {
        source: 'osm',
        external_id: p.external_id,
        kind: p.kind,
        name: clamp(p.name, COLUMN_LIMITS.name),
        website: clamp(p.website, COLUMN_LIMITS.website),
        phone: clamp(p.phone, COLUMN_LIMITS.phone),
        geom: { type: 'Point', coordinates: [p.lng, p.lat] },
        last_imported_at: batchTime,
      });
    };
    for (const p of pois) add(p);
    for (const a of accommodations) add(a);
    const rows = [...byExternalId.values()];

    for (const part of chunk(rows, UPSERT_CHUNK)) {
      if (part.length) {
        await this.repo.upsert(part, {
          conflictPaths: ['source', 'external_id'],
        });
      }
    }

    const fetched = pois.length + accommodations.length;
    this.logger.log(
      `POI import (osm): fetched=${fetched} ` +
        `(poi=${pois.length} accommodation=${accommodations.length}) ` +
        `upserted=${rows.length}`,
    );
    return { fetched, upserted: rows.length };
  }
}
