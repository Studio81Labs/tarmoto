import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { DeviceTokensService } from './device-tokens.service.js';
import {
  RegisterDeviceDto,
  RegisterDeviceResponseDto,
  UnregisterDeviceDto,
} from './dto/register-device.dto.js';

@ApiTags('me')
@Controller('me/devices')
export class DevicesController {
  constructor(private readonly deviceTokens: DeviceTokensService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register an FCM/APN device token for the authenticated user',
  })
  @ApiBody({ type: RegisterDeviceDto })
  @ApiResponse({ status: 201, type: RegisterDeviceResponseDto })
  async register(
    @Req() req: Request,
    @Body() dto: RegisterDeviceDto,
  ): Promise<RegisterDeviceResponseDto> {
    return this.deviceTokens.register(req.user!.userId, dto);
  }

  @Delete()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Unregister a device token (call on logout / push opt-out)',
    description:
      'Token is supplied in the request body rather than the URL path. ' +
      'FCM tokens are ~150 chars of opaque base64url and APN tokens are ' +
      '64 hex chars; while neither contains path-separator characters, ' +
      'keeping a long opaque credential out of the URL avoids leaking it ' +
      'into access logs and sidesteps Express path-match edge cases.',
  })
  @ApiBody({ type: UnregisterDeviceDto })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse({ status: 204 })
  async unregister(
    @Req() req: Request,
    @Body() dto: UnregisterDeviceDto,
  ): Promise<void> {
    await this.deviceTokens.unregister(req.user!.userId, dto.token);
  }
}
