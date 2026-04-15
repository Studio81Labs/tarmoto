import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { BadgesService } from './badges.service.js';
import { BadgeDto, CheckBadgesResponseDto } from './dto/badges.dto.js';

@ApiTags('badges')
@Controller()
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get('users/:userId/badges')
  @ApiOperation({ summary: "List a user's badges with progress" })
  @ApiResponse({ status: 200, type: [BadgeDto] })
  async listBadges(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<BadgeDto[]> {
    return this.badgesService.listBadges(userId);
  }

  @Post('badges/check')
  @ApiOperation({ summary: 'Check and award new badges for current user' })
  @ApiResponse({ status: 201, type: CheckBadgesResponseDto })
  async checkBadges(
    @Req() req: express.Request,
  ): Promise<CheckBadgesResponseDto> {
    return this.badgesService.checkAndAward(req.user!.userId);
  }
}
