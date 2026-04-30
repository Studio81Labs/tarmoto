import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { ExplorationService } from './exploration.service.js';
import {
  ExplorationStatsDto,
  NearbyUnriddenQueryDto,
  UnriddenSegmentDto,
  RiddenSegmentIdsDto,
  RiddenSegmentsListDto,
} from './dto/exploration.dto.js';

@ApiTags('exploration')
@Controller('exploration')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class ExplorationController {
  constructor(private readonly explorationService: ExplorationService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get exploration stats (ridden vs total)' })
  @ApiResponse({ status: 200, type: ExplorationStatsDto })
  async getStats(@Req() req: express.Request): Promise<ExplorationStatsDto> {
    return this.explorationService.getStats(req.user!.userId);
  }

  @Get('nearby-unridden')
  @ApiOperation({ summary: 'Get nearby unridden road segments' })
  @ApiResponse({ status: 200, type: [UnriddenSegmentDto] })
  async getNearbyUnridden(
    @Req() req: express.Request,
    @Query() query: NearbyUnriddenQueryDto,
  ): Promise<UnriddenSegmentDto[]> {
    return this.explorationService.getNearbyUnridden(
      req.user!.userId,
      query.lat,
      query.lng,
      query.radius_km ?? 10,
      query.limit ?? 20,
    );
  }

  @Get('ridden-ids')
  @ApiOperation({ summary: 'Get all ridden road segment IDs for map overlay' })
  @ApiResponse({ status: 200, type: RiddenSegmentIdsDto })
  async getRiddenIds(
    @Req() req: express.Request,
  ): Promise<RiddenSegmentIdsDto> {
    return this.explorationService.getRiddenIds(req.user!.userId);
  }

  @Get('ridden-segments')
  @ApiOperation({
    summary:
      'Ridden segments with last-ridden timestamp + quality (powers personal road map US-50)',
  })
  @ApiResponse({ status: 200, type: RiddenSegmentsListDto })
  async getRiddenSegments(
    @Req() req: express.Request,
  ): Promise<RiddenSegmentsListDto> {
    return this.explorationService.getRiddenSegments(req.user!.userId);
  }
}
