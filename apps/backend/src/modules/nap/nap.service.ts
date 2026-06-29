import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { napConfig } from './nap.config.js';
import { NapClientService } from './nap-client.service.js';
import { Datex2ParserService } from './datex2-parser.service.js';
import { NapReconcileService } from './nap-reconcile.service.js';
import type {
  NapPollStatus,
  NapReconcileResult,
} from './types/nap-situation.types.js';

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
    try {
      const xml = await this.client.fetchSnapshot();
      const situations = this.parser.parse(xml);
      const result = await this.reconcile.reconcile(situations);
      this.lastRunAt = new Date();
      this.lastResult = result;
      return result;
    } catch (err) {
      this.logger.error(
        `NAP poll failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return null;
    } finally {
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
