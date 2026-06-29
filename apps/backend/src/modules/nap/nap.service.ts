import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { napConfig } from './nap.config.js';
import { NapClientService } from './nap-client.service.js';
import { Datex2ParserService } from './datex2-parser.service.js';
import { NapReconcileService } from './nap-reconcile.service.js';
import type {
  NapPollStatus,
  NapReconcileResult,
} from './types/nap-situation.types.js';

/**
 * Postgres session-level advisory-lock key held for the WHOLE poll cycle.
 * The lock must span fetch→parse→reconcile, not just the reconcile write:
 * with multiple workers, a slow older tick could otherwise finish fetching
 * after a newer tick has already reconciled and committed, then reconcile
 * stale data and re-activate closures the newer snapshot removed. Holding
 * a session lock for the whole cycle serialises entire polls across
 * processes; a tick that can't acquire it skips.
 */
const POLL_ADVISORY_LOCK_KEY = 743074307;

/**
 * Orchestrates one NAP ingest cycle: fetch snapshot → parse DATEX II →
 * reconcile into `road_closures`. Driven by the BullMQ poll processor on
 * a recurring schedule. Guarded against overlapping runs and gated on
 * `TARMOTO_NAP_POLL_ENABLED` so it stays dormant until credentials exist.
 */
@Injectable()
export class NapService {
  private readonly logger = new Logger(NapService.name);
  private running = false;
  private lastRunAt: Date | null = null;
  private lastResult: NapReconcileResult | null = null;

  constructor(
    private readonly client: NapClientService,
    private readonly parser: Datex2ParserService,
    private readonly reconcile: NapReconcileService,
    private readonly dataSource: DataSource,
    @Inject(napConfig.KEY)
    private readonly config: ConfigType<typeof napConfig>,
  ) {}

  /** Run one fetch→parse→reconcile cycle. Returns null when skipped/failed. */
  async poll(): Promise<NapReconcileResult | null> {
    if (!this.config.pollEnabled) {
      this.logger.debug(
        'NAP poll skipped: TARMOTO_NAP_POLL_ENABLED is not true',
      );
      return null;
    }
    if (this.running) {
      this.logger.warn('NAP poll skipped: previous run still in progress');
      return null;
    }
    this.running = true;
    // Dedicated connection so the session advisory lock is held (and
    // released) on the same backend across the whole cycle.
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      const lock = await runner.manager.query<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [POLL_ADVISORY_LOCK_KEY],
      );
      if (!lock[0]?.locked) {
        this.logger.warn(
          'NAP poll skipped: advisory lock held by another worker',
        );
        return null;
      }
      try {
        const xml = await this.client.fetchSnapshot();
        const situations = this.parser.parse(xml);
        const result = await this.reconcile.reconcile(situations);
        this.lastRunAt = new Date();
        this.lastResult = result;
        return result;
      } finally {
        await runner.manager.query('SELECT pg_advisory_unlock($1)', [
          POLL_ADVISORY_LOCK_KEY,
        ]);
      }
    } catch (err) {
      // Do NOT swallow real failures into a null "skip". A fetch/auth,
      // parse (malformed snapshot), or DB error must propagate so the
      // BullMQ job fails — honouring the configured attempts/backoff and
      // surfacing on /jobs/health — rather than completing as if nothing
      // ran. Only disabled/overlap/locked return null above.
      this.logger.error(
        `NAP poll failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    } finally {
      await runner.release();
      this.running = false;
    }
  }

  status(): NapPollStatus {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
      lastResult: this.lastResult,
      enabled: this.config.pollEnabled,
    };
  }
}
