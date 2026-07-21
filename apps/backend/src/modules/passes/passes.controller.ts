import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { PassesService } from './passes.service.js';
import {
  CheckRouteDto,
  CheckRouteResponseDto,
  ListPassesQueryDto,
  MountainPassDto,
} from './dto/passes.dto.js';

@ApiTags('passes')
@Controller('passes')
export class PassesController {
  constructor(private readonly passesService: PassesService) {}

  // Mountain pass status is public reference data — unauthenticated
  // visitors landing on /trips/planner (#475) need to see open/closed
  // status without first being forced to sign in. OptionalAuthGuard keeps
  // the endpoint reachable for anonymous callers while still attaching
  // `req.user` if a valid bearer token is supplied for future
  // personalization.
  @Get()
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'List mountain passes (optionally filtered by bbox)',
    description:
      'Returns each known pass with its open/closed/unknown status for ' +
      'the requested `for_month` (or the current UTC month when omitted) ' +
      'derived from the typical seasonal window or any operator override. ' +
      'Use `limit` and `offset` to page through large result sets.',
  })
  @ApiResponse({ status: 200, type: [MountainPassDto] })
  async list(@Query() query: ListPassesQueryDto): Promise<MountainPassDto[]> {
    return this.passesService.list(
      query.bbox,
      query.for_month,
      query.limit,
      query.offset,
    );
  }

  // `check-route` accepts arbitrary coordinates and runs an expensive
  // PostGIS spatial query (`ST_DWithin` over a user-supplied LINESTRING).
  // Keep this one behind AuthGuard so we don't expose unbounded
  // geospatial compute to anonymous traffic — the read at `GET /passes`
  // is enough for the planner's first-paint use case.
  @Post('check-route')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Check which mountain passes a planned route crosses',
    description:
      'Given one or more route polylines returns the unique passes within `buffer_m` ' +
      '(default 1500 m) of the line plus a count of closed/unknown ones. ' +
      'Status is evaluated for the requested `for_month` or the current ' +
      'UTC month when omitted.',
  })
  @ApiResponse({ status: 200, type: CheckRouteResponseDto })
  async checkRoute(@Body() dto: CheckRouteDto): Promise<CheckRouteResponseDto> {
    return this.passesService.checkRoute(dto);
  }
}
