import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { TripsService } from './trips.service.js';
import { TripGeneratorService } from './trip-generator.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { FromShareTripDto } from './dto/from-share-trip.dto.js';
import { ImportTripDto } from './dto/import-trip.dto.js';
import { JoinTripDto } from './dto/join-trip.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { TripDetailDto, TripSummaryDto } from './dto/trip-response.dto.js';
import { GenerateTripDto } from './dto/generate-trip.dto.js';
import { GenerateTripResponseDto } from './dto/generate-trip-response.dto.js';

@ApiTags('trips')
@Controller('trips')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly tripGenerator: TripGeneratorService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List trips the caller can see' })
  @ApiResponse({ status: 200, type: [TripSummaryDto] })
  async list(
    @Req() req: express.Request,
    @Query() query: ListTripsDto,
  ): Promise<TripSummaryDto[]> {
    return this.tripsService.list(req.user!.userId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new trip and become its owner' })
  @ApiResponse({ status: 201, type: TripDetailDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.create(req.user!.userId, dto);
  }

  @Post('import')
  @ApiOperation({
    summary: 'Create a trip seeded from a parsed GPX/KML file (US-20)',
    description:
      'The client (mobile or companion) parses the file locally via the ' +
      'shared `gpx-kml-import` helper and posts the normalised geometry ' +
      'and waypoints. The server creates a single planned day with the ' +
      'supplied geometry — the trip generator is NOT run, since the ' +
      'imported file IS the route. Caller becomes the owner.',
  })
  @ApiResponse({ status: 201, type: TripDetailDto })
  async importRoute(
    @Req() req: express.Request,
    @Body() dto: ImportTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.importFromRoute(req.user!.userId, dto);
  }

  @Post('from-share')
  @ApiOperation({
    summary:
      "Materialise a shared trip into the caller's library, preserving " +
      'multi-day structure (#357)',
    description:
      'Companion-side counterpart to `POST /trips/import` for the deep-link ' +
      'handoff (`tarmoto://trips/import?tripId=...&token=...`). The client ' +
      'posts only the share token; the server reads the snapshot stored ' +
      'under that token and creates one `trip_days` row per snapshot day ' +
      "— retaining each day's route geometry, distance, and waypoints. " +
      'Use this instead of `/trips/import` for shares from the planner so ' +
      "multi-day itineraries land in the rider's library with their day " +
      'breakdown intact. Returns a 404 if the token is unknown or the ' +
      "share's owner has soft-deleted their account; a 400 if the " +
      'snapshot has no usable route data on any day.',
  })
  @ApiResponse({ status: 201, type: TripDetailDto })
  @ApiResponse({
    status: 400,
    description: 'Snapshot has no usable route data',
  })
  @ApiResponse({
    status: 404,
    description: 'Share token unknown or owner account deleted',
  })
  async importFromShare(
    @Req() req: express.Request,
    @Body() dto: FromShareTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.importFromShare(req.user!.userId, dto);
  }

  @Get(':tripId')
  @ApiOperation({ summary: 'Get full trip detail (members, days, waypoints)' })
  @ApiResponse({ status: 200, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async getDetail(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<TripDetailDto> {
    return this.tripsService.getDetail(req.user!.userId, tripId);
  }

  @Patch(':tripId')
  @ApiOperation({
    summary: 'Update trip metadata',
    description:
      'Owner/admin only. Supplied fields overwrite current values; omitted ' +
      'fields are left untouched. Effective (post-patch) bounds are ' +
      're-validated so partial updates cannot land an invalid row.',
  })
  @ApiResponse({ status: 200, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async update(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: UpdateTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.update(req.user!.userId, tripId, dto);
  }

  @Post(':tripId/generate')
  @ApiOperation({
    summary: 'Auto-generate a multi-day itinerary for a trip',
    description:
      'Builds three preset options (Best fit / Scenic sweep / Fastest line) ' +
      "using the trip's persisted parameters (num_days, daily_km bounds, " +
      'min_quality, road_preference, region) plus per-request overrides ' +
      '(start_location, optional bbox, avoidance flags, surface filter). The ' +
      'selected option (default `best-fit`) is persisted to `trip_days`/' +
      '`trip_waypoints` atomically — re-generating overwrites prior days in ' +
      'a single transaction. The other two options are returned as preview ' +
      'data for side-by-side comparison.',
  })
  @ApiResponse({ status: 201, type: GenerateTripResponseDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async generate(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: GenerateTripDto,
  ): Promise<GenerateTripResponseDto> {
    return this.tripGenerator.generate(req.user!.userId, tripId, dto);
  }

  @Post(':tripId/duplicate')
  @ApiOperation({
    summary: 'Duplicate a trip as a new draft',
    description:
      'Deep-copies the trip, its days, and waypoints into a new draft owned ' +
      'by the caller. Members, suggestions, votes, and activity are not copied.',
  })
  @ApiResponse({ status: 201, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async duplicate(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<TripDetailDto> {
    return this.tripsService.duplicate(req.user!.userId, tripId);
  }

  @Delete(':tripId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a trip',
    description:
      'Owner-only. Cascades to members, days, waypoints, suggestions, ' +
      'votes, messages, and activity. Folds "no such trip" and "not the ' +
      'owner" into the same 404 so the endpoint cannot enumerate ids or ' +
      'roles.',
  })
  @ApiResponse({ status: 204, description: 'Trip deleted' })
  @ApiResponse({ status: 404, description: 'Trip not found or not owned' })
  async remove(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<void> {
    await this.tripsService.remove(req.user!.userId, tripId);
  }

  @Post(':tripId/join')
  @ApiOperation({ summary: 'Join a trip via its invite code' })
  @ApiResponse({ status: 201, type: TripDetailDto })
  @ApiResponse({ status: 403, description: 'Invalid trip or invite code' })
  async join(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: JoinTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.join(req.user!.userId, tripId, dto.invite_code);
  }
}
