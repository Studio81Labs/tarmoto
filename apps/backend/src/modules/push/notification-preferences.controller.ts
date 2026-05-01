import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  NotificationChannelTogglesDto,
  NotificationPreferencesResponseDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification-preferences.dto.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

// `NotificationChannelTogglesDto` is referenced via `additionalProperties.$ref`
// on the per-category map but never directly as a request/response type.
// `@ApiExtraModels` forces the swagger plugin to register it under
// `components/schemas/` so the $ref resolves at OpenAPI export time.
@ApiExtraModels(NotificationChannelTogglesDto)
@ApiTags('me')
@Controller('me/notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly prefs: NotificationPreferencesService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Load the authenticated user's notification preferences",
  })
  @ApiResponse({ status: 200, type: NotificationPreferencesResponseDto })
  async get(@Req() req: Request): Promise<NotificationPreferencesResponseDto> {
    return this.prefs.get(req.user!.userId);
  }

  @Put()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update notification preferences (partial — supplied fields only)',
  })
  @ApiBody({ type: UpdateNotificationPreferencesDto })
  @ApiResponse({ status: 200, type: NotificationPreferencesResponseDto })
  async update(
    @Req() req: Request,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    return this.prefs.update(req.user!.userId, dto);
  }
}
