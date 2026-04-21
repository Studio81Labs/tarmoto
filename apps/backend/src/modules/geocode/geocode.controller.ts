import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { GeocodeService } from './geocode.service.js';
import { GeocodeListDto, GeocodeQueryDto } from './dto/geocode.dto.js';

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
}
