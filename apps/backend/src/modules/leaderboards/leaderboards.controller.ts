import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { LeaderboardsService } from './leaderboards.service.js';
import {
  RegionalLeaderboardsQueryDto,
  RegionalLeaderboardsResponseDto,
} from './dto/leaderboards.dto.js';

@ApiTags('leaderboards')
@Controller('leaderboards')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class LeaderboardsController {
  constructor(private readonly service: LeaderboardsService) {}

  @Get('regional')
  @ApiOperation({
    summary: 'Multi-dimensional regional leaderboards',
    description:
      'Top-N riders by total distance, roads discovered, and hazards reported. ' +
      'Filter to a region by passing `region` (matched case-insensitively against ' +
      "the rider's `home_region`); omit for a global ranking. The signed-in " +
      "rider's row is returned per dimension as `me` even when outside the top N.",
  })
  @ApiResponse({ status: 200, type: RegionalLeaderboardsResponseDto })
  async getRegional(
    @Req() req: express.Request,
    @Query() query: RegionalLeaderboardsQueryDto,
  ): Promise<RegionalLeaderboardsResponseDto> {
    return this.service.getRegional({
      region: query.region,
      limit: query.limit,
      currentUserId: req.user!.userId,
    });
  }
}
