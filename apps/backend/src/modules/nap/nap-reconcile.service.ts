import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
 *   1. upsert every situation by `(source, external_id)`, stamping
 *      `last_seen_at = batchTime` and `is_active = true`;
 *   2. deactivate any feed row of this `source` that is absent from the
 *      snapshot (older `last_seen_at`) or whose `ends_at` has passed.
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
    let inserted = 0;
    let updated = 0;
    let needsDecoding = 0;

    const deactivated = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RoadClosure);

      for (const s of situations) {
        if (s.needsLocationDecoding) needsDecoding++;

        const fields = {
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
          is_active: true,
          last_seen_at: batchTime,
        };

        const existing = await repo.findOne({
          where: { source, external_id: s.externalId },
        });

        if (existing) {
          repo.merge(existing, fields);
          await repo.save(existing);
          updated++;
        } else {
          await repo.save(
            repo.create({
              ...fields,
              source,
              external_id: s.externalId,
              created_by: null,
              detour_geom: null,
              region: null,
              notes: null,
              first_seen_at: batchTime,
            }),
          );
          inserted++;
        }
      }

      // Deactivate feed rows absent from this snapshot or already ended.
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

      return result.affected ?? 0;
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
