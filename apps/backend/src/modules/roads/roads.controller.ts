import { Controller, Get, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RoadsService } from './roads.service.js';
import { QueryNearbyDto } from './dto/query-nearby.dto.js';
import {
  RoadSegmentDto,
  RoadSegmentDetailDto,
} from './dto/road-segment.dto.js';
import { QueryFunZonesDto } from './dto/query-fun-zones.dto.js';
import { FunZoneDto } from './dto/fun-zone.dto.js';
import { FunZoneDetailDto } from './dto/fun-zone-detail.dto.js';
import { QueryBestRoadsDto } from './dto/query-best-roads.dto.js';
import { BestRoadsResponseDto } from './dto/best-roads.dto.js';

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
}
