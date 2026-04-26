import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { SafetyService } from './safety.service.js';
import { CrashAlertDto, CrashAlertResponseDto } from './dto/crash-alert.dto.js';

@ApiTags('safety')
@Controller('safety')
// `AuthGuard` populates `req.user.userId`. The app-wide throttler
// (`UserScopedThrottlerGuard` registered as `APP_GUARD`) reads that
// field to bucket by `(ip, user_id)` instead of plain IP, so riders
// behind shared NAT can't exhaust each other's per-route budget.
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Post('crash-alert')
  @HttpCode(HttpStatus.OK)
  // Crash alerts are user-triggered after a hard countdown — bursts
  // are abuse, not legitimate behaviour. Cap at 5/min per (IP, user)
  // to contain runaway clients without blocking the second alert in
  // a genuinely catastrophic ride and without one user starving
  // another sharing the same upstream IP.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({
    summary: 'Send crash alert to emergency contacts',
    description:
      'Triggered by the app when crash detection activates and the ' +
      'countdown timer expires without cancellation. Dispatches SMS ' +
      '(plus an automated voice call when severity=high) via the ' +
      'configured CrashAlertNotifier. Idempotent on `alert_id`.',
  })
  @ApiResponse({ status: 200, type: CrashAlertResponseDto })
  async sendCrashAlert(
    @Req() req: express.Request,
    @Body() dto: CrashAlertDto,
  ): Promise<CrashAlertResponseDto> {
    return this.safetyService.sendCrashAlert(req.user!.userId, dto);
  }
}
