import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { RoadsService } from './roads.service.js';
import {
  RouteQualityRequestDto,
  RouteQualityResponseDto,
} from './dto/route-quality.dto.js';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import { QueryFunZonesDto } from './dto/query-fun-zones.dto.js';
import { CorridorFunZonesDto } from './dto/corridor-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';
import { FunZoneDetailDto } from './dto/fun-zone-detail.dto.js';
import { QueryBestRoadsDto } from './dto/query-best-roads.dto.js';
import { BestRoadsResponseDto } from './dto/best-roads.dto.js';
import { RoadTrendDto } from './dto/road-trend.dto.js';

@ApiTags('roads')
@Controller('roads')
export class RoadsController {
  constructor(private readonly roadsService: RoadsService) {}

  @Get('nearby')
  @ApiOperation({ summary: 'Get road segments near a location' })
  @ApiResponse({ status: 200, type: [RoadSegmentDto] })
  async findNearby(@Query() query: QueryNearbyDto): Promise<RoadSegmentDto[]> {
    return this.roadsService.findNearby(query);
  }

  @Get('fun-zones')
  @ApiOperation({ summary: 'Get fun zones in a bounding box' })
  @ApiResponse({ status: 200, type: [FunZoneDto] })
  async findFunZones(@Query() query: QueryFunZonesDto): Promise<FunZoneDto[]> {
    return this.roadsService.findFunZones(query);
  }

  @Get('fun-zones/:id')
  @ApiOperation({
    summary: 'Get a Fun Zone with its top contributing roads',
  })
  @ApiResponse({ status: 200, type: FunZoneDetailDto })
  @ApiResponse({ status: 404, description: 'Fun zone not found' })
  async findZoneById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FunZoneDetailDto> {
    return this.roadsService.findZoneById(id);
  }

  // Corridor query over a routed polyline (the STOPS-tab `twisty_highlight`
  // layer, #865). Behind AuthGuard for the same reason as `route-quality` /
  // `check-route`: it runs a geospatial query over an arbitrary route body, and
  // the planner is an authenticated, post-login surface.
  @Post('fun-zones/in-corridor')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Fun Zones within a corridor of a routed polyline (STOPS layer)',
  })
  @ApiResponse({ status: 200, type: [FunZoneDto] })
  async findFunZonesInCorridor(
    @Body() dto: CorridorFunZonesDto,
  ): Promise<FunZoneDto[]> {
    return this.roadsService.findFunZonesInCorridor(dto);
  }

  @Get('best')
  @ApiOperation({
    summary: 'Get top-ranked road segments for a curated region',
  })
  @ApiResponse({ status: 200, type: BestRoadsResponseDto })
  @ApiResponse({ status: 404, description: 'Region not found' })
  async findBest(
    @Query() query: QueryBestRoadsDto,
  ): Promise<BestRoadsResponseDto> {
    return this.roadsService.findBest(query);
  }

  // `route-quality` accepts an arbitrary routed polyline and runs the
  // expensive per-sample PostGIS lateral (up to ~12.5k samples). Same rationale
  // as `POST /passes/check-route`: keep it behind AuthGuard so anonymous
  // traffic can't drive unbounded geospatial compute — the planner overlay is
  // an authenticated, post-login surface anyway.
  @Post('route-quality')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Per-segment surface quality for a routed polyline (planner overlay)',
  })
  @ApiResponse({ status: 200, type: RouteQualityResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Route exceeds the maximum length representable at segment scale',
  })
  async getRouteQuality(
    @Body() dto: RouteQualityRequestDto,
  ): Promise<RouteQualityResponseDto> {
    return this.roadsService.getRouteQuality(dto);
  }

  @Get(':segmentId')
  @ApiOperation({
    summary: 'Get road segment details (Road Preview Card data)',
  })
  @ApiResponse({ status: 200, type: RoadSegmentDetailDto })
  @ApiResponse({ status: 404, description: 'Road segment not found' })
  async findById(
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ): Promise<RoadSegmentDetailDto> {
    return this.roadsService.findById(segmentId);
  }

  @Get(':segmentId/trend')
  @ApiOperation({
    summary:
      'Get monthly quality trend for a road segment from surface readings',
  })
  @ApiResponse({ status: 200, type: RoadTrendDto })
  async getTrend(
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ): Promise<RoadTrendDto> {
    return this.roadsService.getSegmentTrend(segmentId);
  }
}
