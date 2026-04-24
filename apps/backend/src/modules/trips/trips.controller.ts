import {
  Body,
  Controller,
  Get,
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
import { CreateTripDto } from './dto/create-trip.dto.js';
import { JoinTripDto } from './dto/join-trip.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { TripDetailDto, TripSummaryDto } from './dto/trip-response.dto.js';

@ApiTags('trips')
@Controller('trips')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

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
