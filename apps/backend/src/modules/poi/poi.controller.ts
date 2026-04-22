import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PoiService } from './poi.service.js';
import {
  AccommodationListDto,
  AccommodationQueryDto,
} from './dto/accommodation.dto.js';
import { PoiListDto, PoiQueryDto } from './dto/point-of-interest.dto.js';

@ApiTags('poi')
@Controller('poi')
export class PoiController {
  constructor(private readonly poiService: PoiService) {}

  @Get('accommodations')
  @ApiOperation({
    summary: 'Find accommodations near a point (US-10, US-36)',
    description:
      'Returns nearby hotels, guest houses, camp sites, etc. sourced ' +
      'from the configured POI provider. Used by the mobile trip planner ' +
      'to suggest overnight stops near each day-end waypoint. Optional ' +
      '`kinds` narrows by tourism type (e.g. hotels only) and optional ' +
      '`min_stars` narrows by rider rating.',
  })
  @ApiResponse({ status: 200, type: AccommodationListDto })
  async findAccommodations(
    @Query() query: AccommodationQueryDto,
  ): Promise<AccommodationListDto> {
    return this.poiService.findAccommodationsNear(
      query.lat,
      query.lng,
      query.radius_km,
      query.kinds,
      query.min_stars,
    );
  }

  @Get('nearby')
  @ApiOperation({
    summary: 'Find along-route POIs near a point (US-10)',
    description:
      'Returns nearby restaurants, viewpoints, and cafés sourced from ' +
      'the configured POI provider. Used by the mobile trip planner to ' +
      'suggest pit stops along each day of a trip. Omit `kinds` to ' +
      'request all supported kinds in one call.',
  })
  @ApiResponse({ status: 200, type: PoiListDto })
  async findPointsOfInterest(@Query() query: PoiQueryDto): Promise<PoiListDto> {
    return this.poiService.findPointsOfInterestNear(
      query.lat,
      query.lng,
      query.radius_km,
      query.kinds,
    );
  }
}
