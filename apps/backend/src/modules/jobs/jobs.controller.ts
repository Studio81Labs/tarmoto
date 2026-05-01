import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  QueueHealthService,
  type QueueHealthSnapshot,
} from './queue-health.service.js';
import { JOBS_CONFIG_TOKEN, type JobsConfig } from './jobs.tokens.js';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly health: QueueHealthService,
    @Inject(JOBS_CONFIG_TOKEN)
    private readonly config: JobsConfig,
  ) {}

  /**
   * Operational health snapshot for every registered queue. Public
   * (no AuthGuard) because:
   *   - it returns aggregate counters, never per-user data;
   *   - on-call dashboards (Grafana, status pages, uptime probes)
   *     need to scrape it without a user token;
   *   - the throttler is skipped because dashboards poll on a tight
   *     cadence and would otherwise burn through the per-IP budget.
   *
   * Returns counters even when Redis is unhealthy — see
   * `QueueHealthService.entryFor` for the per-queue failure-mode
   * reporting that makes a partial outage visible instead of 500.
   */
  @Get('health')
  @SkipThrottle()
  @ApiOperation({
    summary: 'Queue depth and most-recent failure per queue',
    description:
      'Aggregate counters per BullMQ queue (waiting, active, delayed, completed, failed) plus a summary of the latest failed job. Public endpoint suitable for status-page polling.',
  })
  @ApiResponse({ status: 200 })
  async getHealth(): Promise<QueueHealthSnapshot> {
    return this.health.snapshot(this.config.workersEnabled);
  }
}
