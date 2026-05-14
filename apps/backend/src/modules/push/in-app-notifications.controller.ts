import {
  Controller,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  InAppNotificationDto,
  InAppNotificationListResponseDto,
} from './dto/in-app-notification.dto.js';
import { InAppNotificationsService } from './in-app-notifications.service.js';

@ApiTags('me')
@Controller('me/notifications')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class InAppNotificationsController {
  constructor(private readonly notifications: InAppNotificationsService) {}

  @Get()
  @ApiOperation({
    summary: "List the authenticated user's in-app notifications",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: InAppNotificationListResponseDto })
  async list(
    @Req() req: Request,
    @Query('limit') limit?: string,
  ): Promise<InAppNotificationListResponseDto> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.notifications.list(req.user!.userId, parsed);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one in-app notification as read' })
  @ApiResponse({ status: 200, type: InAppNotificationDto })
  async markRead(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InAppNotificationDto> {
    return this.notifications.markRead(req.user!.userId, id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all in-app notifications as read' })
  @ApiResponse({ status: 200, type: InAppNotificationListResponseDto })
  async markAllRead(
    @Req() req: Request,
  ): Promise<InAppNotificationListResponseDto> {
    return this.notifications.markAllRead(req.user!.userId);
  }
}
