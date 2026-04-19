import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PoiService } from './poi.service.js';
import {
  AccommodationListDto,
  AccommodationQueryDto,
} from './dto/accommodation.dto.js';

@ApiTags('poi')
@Controller('poi')
export class PoiController {
  constructor(private readonly poiService: PoiService) {}

  @Get('accommodations')
  @ApiOperation({
    summary: 'Find accommodations near a point (US-10)',
    description:
      'Returns nearby hotels, guest houses, camp sites, etc. sourced ' +
      'from the configured POI provider. Used by the mobile trip planner ' +
      'to suggest overnight stops near each day-end waypoint.',
  })
  @ApiResponse({ status: 200, type: AccommodationListDto })
  async findAccommodations(
    @Query() query: AccommodationQueryDto,
  ): Promise<AccommodationListDto> {
    return this.poiService.findAccommodationsNear(
      query.lat,
      query.lng,
      query.radius_km,
    );
  }
}
