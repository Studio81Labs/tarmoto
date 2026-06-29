import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import type * as GeoJSON from 'geojson';
import { RoadClosure } from '../../entities/road-closure.entity.js';
import { napConfig } from './nap.config.js';
import type {
  NapReconcileResult,
  NapSituation,
} from './types/nap-situation.types.js';

/**
 * Reconciles a parsed NAP snapshot into `road_closures` (#743).
 *
 * The NDIC snapshot always contains ALL currently- and future-valid
 * situations, so "absent from this snapshot" == "ended". In one
 * transaction (so readers never see a half-applied batch) we:
 *   1. preload the existing feed rows for the snapshot's external ids in
 *      a single query (to keep `first_seen_at` stable and to count
 *      inserts vs updates);
 *   2. bulk-upsert every situation by `(source, external_id)`, stamping
 *      `last_seen_at = batchTime` and `is_active = true`;
 *   3. deactivate any feed row of this `source` that is absent from the
 *      snapshot (older `last_seen_at`) or whose `ends_at` has passed.
 *
 * Two queries + one upsert per poll instead of a `findOne`+`save` per
 * record — a national snapshot is thousands of situations every ~3 min,
 * so per-record round trips would hold the transaction open long enough
 * to overrun the next tick.
 *
 * Deactivated rows are kept (not deleted) for audit. Operator-entered
 * rows have no `external_id` and a different `source`, so the reconcile
 * pass never touches them.
 */
/**
 * Rows per bulk upsert. Each row binds ~19 parameters, and PostgreSQL
 * caps a statement at 65,535 bind parameters, so a full national snapshot
 * (thousands of situations) must be chunked or the whole poll fails
 * before any closure is refreshed. 500 × ~19 ≈ 9.5k, comfortably under.
 */
const UPSERT_CHUNK = 500;
/** Max ids per preload `IN (...)` query (one bind parameter each). */
const PRELOAD_CHUNK = 1000;
/**
 * Postgres transaction-level advisory-lock key for the NAP reconcile.
 * In a multi-worker deployment the in-process overlap guard isn't enough:
 * two processes could reconcile concurrently and an older snapshot
 * finishing last would stamp a newer `last_seen_at` and re-activate
 * closures the newer snapshot had removed. This lock serialises reconciles
 * across processes; a tick that can't acquire it skips (no deactivation),
 * and the next tick re-fetches a fresh snapshot. Auto-released at COMMIT.
 */
const RECONCILE_ADVISORY_LOCK_KEY = 743074307;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

@Injectable()
export class NapReconcileService {
  private readonly logger = new Logger(NapReconcileService.name);

  constructor(
    @InjectRepository(RoadClosure)
    private readonly repo: Repository<RoadClosure>,
    private readonly dataSource: DataSource,
    @Inject(napConfig.KEY)
    private readonly config: ConfigType<typeof napConfig>,
  ) {}

  async reconcile(situations: NapSituation[]): Promise<NapReconcileResult> {
    const source = this.config.source;
    const batchTime = new Date();

    // Dedupe by external id (last wins) — a duplicate id within one
    // snapshot would otherwise make a single upsert touch the same row
    // twice and abort the batch.
    const byExternalId = new Map<string, NapSituation>();
    for (const s of situations) byExternalId.set(s.externalId, s);
    const deduped = [...byExternalId.values()];
    const externalIds = [...byExternalId.keys()];

    const result = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RoadClosure);

      // 0) Serialise reconciles across worker processes. If another
      //    process holds the lock, skip this tick entirely (no upsert, no
      //    deactivation) rather than interleave two snapshots.
      const lock = await manager.query<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [RECONCILE_ADVISORY_LOCK_KEY],
      );
      if (!lock[0]?.locked) {
        this.logger.warn(
          'NAP reconcile skipped: advisory lock held by another worker',
        );
        return null;
      }

      // 1) Preload existing feed rows (chunked `IN (...)`) so we can keep
      //    each row's original first_seen_at, count inserts vs updates,
      //    and preserve any geometry a decoder already resolved.
      const existing: RoadClosure[] = [];
      for (const ids of chunk(externalIds, PRELOAD_CHUNK)) {
        existing.push(
          ...(await repo.find({
            where: { source, external_id: In(ids) },
            select: {
              external_id: true,
              first_seen_at: true,
              geom: true,
              needs_location_decoding: true,
              raw_location_ref: true,
            },
          })),
        );
      }
      const existingByExt = new Map<string, RoadClosure>(
        existing.map((r) => [r.external_id as string, r]),
      );

      // 2) Build the upsert rows. For a situation the feed still gives no
      //    coordinates for, PRESERVE an existing decoded geometry instead
      //    of overwriting it back to null every poll — otherwise a row
      //    decoded out-of-band (the whole point of raw_location_ref)
      //    would vanish from public reads on the next ~3-min tick. BUT only
      //    when the raw location reference is unchanged: if the feed item
      //    now points at a different location, the old geometry is stale,
      //    so reset to null + needs decoding to trigger a fresh decode.
      let needsDecoding = 0;
      const rows = deduped.map((s) => {
        const ex = existingByExt.get(s.externalId);
        let geom: GeoJSON.LineString | null = s.geometry;
        let needsLocationDecoding = false;
        if (!s.geometry) {
          const sameLocation =
            JSON.stringify(ex?.raw_location_ref ?? null) ===
            JSON.stringify(s.rawLocationRef ?? null);
          if (ex?.geom && sameLocation) {
            geom = ex.geom; // same location, already decoded — keep it
          } else {
            geom = null;
            needsLocationDecoding = true;
          }
        }
        if (needsLocationDecoding) needsDecoding++;

        return {
          title: s.title,
          reason: s.reason,
          severity: s.severity,
          geom,
          country_code: this.config.countryCode,
          starts_at: s.startsAt ?? batchTime,
          ends_at: s.endsAt,
          validity_status: s.validityStatus,
          needs_location_decoding: needsLocationDecoding,
          raw_location_ref: s.rawLocationRef ?? null,
          // A situation present in the snapshot is live UNLESS DATEX
          // marks it `suspended` or `planned` (planned = not in force
          // yet) — the public read paths filter on `is_active` + the
          // time window, not `validity_status`, so such a record with
          // geometry (and a reached/omitted start time) would otherwise
          // show on the map and in route-closure warnings. `active` and
          // `definedByValidityTimeSpecification` stay active (the window
          // governs the latter).
          is_active:
            s.validityStatus !== 'suspended' && s.validityStatus !== 'planned',
          last_seen_at: batchTime,
          source,
          external_id: s.externalId,
          created_by: null,
          detour_geom: null,
          region: null,
          notes: null,
          first_seen_at: ex?.first_seen_at ?? batchTime,
        };
      });

      // Chunk the upsert to stay under PostgreSQL's 65,535-parameter
      // statement limit on a large national snapshot.
      for (const part of chunk(rows, UPSERT_CHUNK)) {
        // Cast through unknown: the row shape is correct by
        // construction, but TypeORM's QueryDeepPartialEntity rejects the
        // `unknown` raw_location_ref / geom-union fields structurally.
        await repo.upsert(
          part as unknown as QueryDeepPartialEntity<RoadClosure>[],
          { conflictPaths: ['source', 'external_id'] },
        );
      }

      // 3) Deactivate feed rows absent from this snapshot or already ended.
      const deactivateResult = await repo
        .createQueryBuilder()
        .update(RoadClosure)
        .set({ is_active: false })
        .where('source = :source', { source })
        .andWhere('is_active = true')
        .andWhere(
          '(last_seen_at IS NULL OR last_seen_at < :batchTime OR (ends_at IS NOT NULL AND ends_at < :batchTime))',
          { batchTime },
        )
        .execute();

      const insertedCount = deduped.filter(
        (s) => !existingByExt.has(s.externalId),
      ).length;
      return {
        inserted: insertedCount,
        updated: deduped.length - insertedCount,
        deactivated: deactivateResult.affected ?? 0,
        needsDecoding,
      };
    });

    const summary: NapReconcileResult = {
      parsed: situations.length,
      inserted: result?.inserted ?? 0,
      updated: result?.updated ?? 0,
      deactivated: result?.deactivated ?? 0,
      // When the reconcile is skipped (lock not acquired), nothing was
      // examined — report 0 rather than the would-be count.
      needsDecoding: result?.needsDecoding ?? 0,
    };
    this.logger.log(
      `NAP reconcile (${source})${result ? '' : ' [skipped: locked]'}: ` +
        `parsed=${summary.parsed} inserted=${summary.inserted} ` +
        `updated=${summary.updated} deactivated=${summary.deactivated} ` +
        `needsDecoding=${summary.needsDecoding}`,
    );
    return summary;
  }
}
