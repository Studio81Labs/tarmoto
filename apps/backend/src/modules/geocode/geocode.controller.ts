import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard.js';
import { GeocodeService } from './geocode.service.js';
import {
  GeocodeListDto,
  GeocodeQueryDto,
  ReverseGeocodeQueryDto,
  ReverseGeocodeResultDto,
} from './dto/geocode.dto.js';

// Explicit per-user rate limit for this Nominatim-backed proxy: pinned to the
// app default (60/min ≈ 1 req/s) so a single client can't individually exceed
// OSMF's ~1 req/s-per-source policy, independent of any later change to the
// global default. Generous enough for debounced typeahead + pin naming; the
// GeocodeService response cache is the primary upstream-load reducer (#909).
@Throttle({ default: { ttl: 60_000, limit: 60 } })
@ApiTags('geocode')
@Controller('geocode')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class GeocodeController {
  constructor(private readonly geocodeService: GeocodeService) {}

  @Get()
  @ApiOperation({
    summary: 'Resolve a place name to coordinates',
    description:
      'Proxies the configured geocoder (Nominatim by default, per ' +
      'ADR-0002) and returns a normalized list of matches. Used by the ' +
      'companion ride search to resolve "passes near <place>" queries.',
  })
  @ApiResponse({ status: 200, type: GeocodeListDto })
  async search(@Query() query: GeocodeQueryDto): Promise<GeocodeListDto> {
    return this.geocodeService.search(query.q, query.limit);
  }

  @Get('reverse')
  @ApiOperation({
    summary: 'Name a coordinate',
    description:
      'Reverse-geocodes a coordinate to the enclosing place name (town, ' +
      'city, or region), used by the planner to label map-placed pins. ' +
      'Returns { label: null } when the point cannot be named.',
  })
  @ApiResponse({ status: 200, type: ReverseGeocodeResultDto })
  async reverse(
    @Query() query: ReverseGeocodeQueryDto,
  ): Promise<ReverseGeocodeResultDto> {
    return this.geocodeService.reverse(query.lat, query.lng);
  }
}
