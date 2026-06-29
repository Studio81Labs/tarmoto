import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NapService } from './nap.service.js';
import type { NapPollStatus } from './types/nap-situation.types.js';

/**
 * Read-only observability for the NAP closure poller (#743). The feed's
 * closures are served through the existing `/closures` endpoints (they
 * land in `road_closures` with `source = 'official'`); this controller
 * only exposes poller health. A guarded manual-refresh trigger is a
 * follow-up.
 */
@ApiTags('nap')
@Controller('nap/closures')
export class NapController {
  constructor(private readonly nap: NapService) {}

  @Get('status')
  @ApiOperation({ summary: 'Last NAP poll time + reconcile result' })
  status(): NapPollStatus {
    return this.nap.status();
  }
}
