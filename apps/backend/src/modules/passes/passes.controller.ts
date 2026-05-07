import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { PassesService } from './passes.service.js';
import {
  CheckRouteDto,
  CheckRouteResponseDto,
  ListPassesQueryDto,
  MountainPassDto,
} from './dto/passes.dto.js';

// Mountain pass status is public reference data — anyone planning a trip
// (including unauthenticated visitors landing on /trips/planner) needs to
// see open/closed status. We use OptionalAuthGuard so the endpoint stays
// reachable without a Bearer token while still attaching `req.user` if a
// valid one is supplied for future personalization.
@ApiTags('passes')
@Controller('passes')
@UseGuards(OptionalAuthGuard)
export class PassesController {
  constructor(private readonly passesService: PassesService) {}

  @Get()
  @ApiOperation({
    summary: 'List mountain passes (optionally filtered by bbox)',
    description:
      'Returns each known pass with its open/closed/unknown status for ' +
      'the requested `for_month` (or the current UTC month when omitted) ' +
      'derived from the typical seasonal window or any operator override.',
  })
  @ApiResponse({ status: 200, type: [MountainPassDto] })
  async list(@Query() query: ListPassesQueryDto): Promise<MountainPassDto[]> {
    return this.passesService.list(query.bbox, query.for_month);
  }

  @Post('check-route')
  @ApiOperation({
    summary: 'Check which mountain passes a planned route crosses',
    description:
      'Given a route polyline returns the passes within `buffer_m` ' +
      '(default 1500 m) of the line plus a count of closed/unknown ones. ' +
      'Status is evaluated for the requested `for_month` or the current ' +
      'UTC month when omitted.',
  })
  @ApiResponse({ status: 200, type: CheckRouteResponseDto })
  async checkRoute(@Body() dto: CheckRouteDto): Promise<CheckRouteResponseDto> {
    return this.passesService.checkRoute(dto);
  }
}
