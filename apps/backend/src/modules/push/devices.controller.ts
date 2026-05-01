import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
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

  @Delete(':token')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Unregister a device token (call on logout / push opt-out)',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse({ status: 204 })
  async unregister(
    @Req() req: Request,
    @Param('token') token: string,
  ): Promise<void> {
    await this.deviceTokens.unregister(req.user!.userId, token);
  }
}
