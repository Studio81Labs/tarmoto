import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PoiService } from './poi.service.js';
import { PoiStoreService } from './poi-store.service.js';
import {
  AccommodationListDto,
  AccommodationQueryDto,
} from './dto/accommodation.dto.js';
import {
  AlongRoutePoiListDto,
  AlongRoutePoiQueryDto,
  PoiListDto,
  PoiQueryDto,
} from './dto/point-of-interest.dto.js';
import {
  CorridorBodyDto,
  DEFAULT_LIMIT,
  InBboxQueryDto,
  StoredCorridorListDto,
  StoredPoiDto,
  StoredPoiListDto,
} from './dto/stored-poi.dto.js';

@ApiTags('poi')
@Controller('poi')
export class PoiController {
  constructor(
    private readonly poiService: PoiService,
    private readonly poiStore: PoiStoreService,
  ) {}

  @Get('accommodations')
  @ApiOperation({
    summary: 'Find accommodations near a point (US-10, US-36)',
    description:
      'Returns nearby hotels, guest houses, camp sites, etc. sourced ' +
      'from the configured POI provider. Used by the mobile trip planner ' +
      'to suggest overnight stops near each day-end waypoint. Optional ' +
      '`kinds` narrows by tourism type (e.g. hotels only) and optional ' +
      '`min_stars` narrows by provider-reported star rating.',
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

  @Get('in-bbox')
  @ApiOperation({
    summary: 'List stored POIs within a bounding box (#849)',
    description:
      'Reads the offline `pois` store (populated by the weekly import) rather ' +
      'than hitting Overpass live — this is the read path a pannable POI map ' +
      'layer and the companion category bar use. Returns an empty list for a ' +
      'region that has not been imported yet.',
  })
  @ApiResponse({ status: 200, type: StoredPoiListDto })
  async findInBbox(@Query() query: InBboxQueryDto): Promise<StoredPoiListDto> {
    const pois = await this.poiStore.findInBbox(
      {
        minLng: query.min_lng,
        minLat: query.min_lat,
        maxLng: query.max_lng,
        maxLat: query.max_lat,
      },
      query.kinds,
      query.limit ?? DEFAULT_LIMIT,
    );
    return { pois, count: pois.length };
  }

  @Post('in-corridor')
  @ApiOperation({
    summary: 'Stored POIs within a buffer of a route polyline (#849)',
    description:
      'The offline-store corridor query behind the companion STOPS tab — the ' +
      'store counterpart to POST /poi/along-route. Each POI carries its ' +
      'distance along the route and its shortest distance to the route line. ' +
      'Returns an empty list for a region that has not been imported yet.',
  })
  @ApiResponse({ status: 200, type: StoredCorridorListDto })
  async findInCorridor(
    @Body() body: CorridorBodyDto,
  ): Promise<StoredCorridorListDto> {
    const { pois, buffer_km } = await this.poiStore.findAlongRoute(
      body.route,
      body.kinds,
      body.buffer_km,
    );
    return { pois, buffer_km, count: pois.length };
  }

  @Post('along-route')
  @ApiOperation({
    summary: 'Find POIs within a buffer of a route polyline (US-36)',
    description:
      'Given a route polyline, returns POIs (fuel stations, restaurants, ' +
      'viewpoints, cafés) within `buffer_km` of any route vertex. Each ' +
      'POI is annotated with its distance along the route (in km from ' +
      'start) and its shortest distance to the route, so clients can ' +
      'order them on a day timeline and judge reachability. Used by the ' +
      'mobile fuel-range warning to surface live fuel stations inside ' +
      'legs that exceed the rider’s declared range.',
  })
  @ApiResponse({ status: 200, type: AlongRoutePoiListDto })
  async findPointsOfInterestAlongRoute(
    @Body() dto: AlongRoutePoiQueryDto,
  ): Promise<AlongRoutePoiListDto> {
    return this.poiService.findPointsOfInterestAlongRoute(dto);
  }

  // Declared LAST: `:id` is a catch-all param route, so it must come after
  // every static GET path above (`accommodations`, `nearby`, `in-bbox`)
  // or it would shadow them.
  @Get(':id')
  @ApiOperation({
    summary: 'Fetch a single stored POI by id (#849)',
    description:
      'Returns one row from the offline `pois` store — the map popup / detail ' +
      'view fetch. 400 when `id` is not a valid UUID; 404 when it is unknown.',
  })
  @ApiResponse({ status: 200, type: StoredPoiDto })
  async findById(
    // `id` is a UUID column — validate before the query so a non-UUID path
    // (`/poi/garbage`) is a 400, not a Postgres `invalid input syntax` 500.
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StoredPoiDto> {
    const poi = await this.poiStore.findById(id);
    if (!poi) {
      throw new NotFoundException('POI not found');
    }
    return poi;
  }
}
