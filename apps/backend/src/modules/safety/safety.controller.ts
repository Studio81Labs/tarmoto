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
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { SafetyService } from './safety.service.js';
import { CrashAlertDto, CrashAlertResponseDto } from './dto/crash-alert.dto.js';

@ApiTags('safety')
@Controller('safety')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Post('crash-alert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send crash alert to emergency contacts',
    description:
      'Triggered by the app when crash detection activates and ' +
      'the countdown timer expires without cancellation.',
  })
  @ApiResponse({ status: 200, type: CrashAlertResponseDto })
  async sendCrashAlert(
    @Req() req: express.Request,
    @Body() dto: CrashAlertDto,
  ): Promise<CrashAlertResponseDto> {
    return this.safetyService.sendCrashAlert(req.user!.userId, dto);
  }
}
