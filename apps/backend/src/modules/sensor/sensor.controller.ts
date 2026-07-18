import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
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
import { SystemSwitchGuard } from '../features/system-switch.guard.js';
import { RequireSystemSwitch } from '../features/require-system-switch.decorator.js';
import { SensorService } from './sensor.service.js';
import { UploadSensorDataDto } from './dto/upload-sensor-data.dto.js';
import { UploadResponseDto } from './dto/upload-response.dto.js';

@ApiTags('sensor')
@Controller('sensor')
export class SensorController {
  constructor(private readonly sensorService: SensorService) {}

  @Post('upload')
  @UseGuards(SystemSwitchGuard, AuthGuard)
  @RequireSystemSwitch('sys_surface_upload')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Upload batched accelerometer readings',
    description:
      'Upload a batch of sensor readings collected during a ride. ' +
      'Readings are processed server-side to update road quality scores.',
  })
  @ApiResponse({ status: 202, type: UploadResponseDto })
  async upload(
    @Req() req: express.Request,
    @Body() dto: UploadSensorDataDto,
  ): Promise<UploadResponseDto> {
    return this.sensorService.processUpload(req.user!.userId, dto);
  }
}
