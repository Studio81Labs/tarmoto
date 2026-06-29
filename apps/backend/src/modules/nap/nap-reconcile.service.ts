import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
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
    const needsDecoding = situations.filter(
      (s) => s.needsLocationDecoding,
    ).length;

    // Dedupe by external id (last wins) — a duplicate id within one
    // snapshot would otherwise make a single upsert touch the same row
    // twice and abort the batch.
    const byExternalId = new Map<string, NapSituation>();
    for (const s of situations) byExternalId.set(s.externalId, s);
    const deduped = [...byExternalId.values()];
    const externalIds = [...byExternalId.keys()];

    const { inserted, updated, deactivated } =
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(RoadClosure);

        // 1) Preload existing feed rows for these ids (one query) so the
        //    upsert can preserve each row's original first_seen_at and we
        //    can count inserts vs updates.
        const existing = externalIds.length
          ? await repo.find({
              where: { source, external_id: In(externalIds) },
              select: { external_id: true, first_seen_at: true },
            })
          : [];
        const firstSeenByExt = new Map<string, Date | null>(
          existing.map((r) => [r.external_id as string, r.first_seen_at]),
        );

        // 2) Bulk upsert by (source, external_id) — the plain unique
        //    index added in the schema migration. first_seen_at is set
        //    from the preload, so an update preserves the original and an
        //    insert stamps batchTime.
        const rows = deduped.map((s) => ({
          title: s.title,
          reason: s.reason,
          severity: s.severity,
          geom: s.geometry,
          country_code: this.config.countryCode,
          starts_at: s.startsAt ?? batchTime,
          ends_at: s.endsAt,
          validity_status: s.validityStatus,
          needs_location_decoding: s.needsLocationDecoding,
          raw_location_ref: s.rawLocationRef ?? null,
          // A situation present in the snapshot is live UNLESS DATEX marks
          // it `suspended` or `planned` (planned = not in force yet) — the
          // public read paths filter on `is_active` + the time window, not
          // `validity_status`, so such a record with geometry (and a start
          // time already reached or omitted) would otherwise show on the
          // map and in route-closure warnings. `active` and
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
          first_seen_at: firstSeenByExt.get(s.externalId) ?? batchTime,
        }));
        if (rows.length) {
          // Cast through unknown: the row shape is correct by
          // construction, but TypeORM's QueryDeepPartialEntity rejects the
          // `unknown` raw_location_ref / geom-union fields structurally.
          await repo.upsert(
            rows as unknown as QueryDeepPartialEntity<RoadClosure>[],
            { conflictPaths: ['source', 'external_id'] },
          );
        }

        // 3) Deactivate feed rows absent from this snapshot or already ended.
        const result = await repo
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
          (s) => !firstSeenByExt.has(s.externalId),
        ).length;
        return {
          inserted: insertedCount,
          updated: deduped.length - insertedCount,
          deactivated: result.affected ?? 0,
        };
      });

    const summary: NapReconcileResult = {
      parsed: situations.length,
      inserted,
      updated,
      deactivated,
      needsDecoding,
    };
    this.logger.log(
      `NAP reconcile (${source}): parsed=${summary.parsed} ` +
        `inserted=${inserted} updated=${updated} ` +
        `deactivated=${summary.deactivated} needsDecoding=${needsDecoding}`,
    );
    return summary;
  }
}
