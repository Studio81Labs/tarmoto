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
