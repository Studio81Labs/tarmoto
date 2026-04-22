import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { SharingService } from './sharing.service.js';
import {
  ToggleShareDto,
  CommunityRidesQueryDto,
  SharedRideResponseDto,
  SharedRideDetailDto,
  CommunityRidesResponseDto,
} from './dto/sharing.dto.js';

@ApiTags('sharing')
@Controller('rides')
export class SharingController {
  constructor(private readonly sharingService: SharingService) {}

  @Post(':rideId/share')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Share or update sharing for a ride' })
  @ApiResponse({ status: 201, type: SharedRideResponseDto })
  @ApiResponse({ status: 400, description: 'Ride not completed' })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  async toggleShare(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: ToggleShareDto,
  ): Promise<SharedRideResponseDto> {
    return this.sharingService.toggleShare(
      req.user!.userId,
      rideId,
      dto.is_public,
    );
  }

  @Delete(':rideId/share')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove sharing for a ride' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async unshare(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<void> {
    return this.sharingService.unshare(req.user!.userId, rideId);
  }

  @Get('shared/:token')
  @ApiOperation({ summary: 'View a shared ride by token (no auth required)' })
  @ApiResponse({ status: 200, type: SharedRideDetailDto })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async getSharedRide(
    @Param('token') token: string,
  ): Promise<SharedRideDetailDto> {
    return this.sharingService.getByToken(token);
  }

  @Get('community')
  @ApiOperation({
    summary: 'Browse the public community ride feed',
    description:
      'Filter by region (`lat`/`lng`/`radius_km`), distance, road quality, ' +
      'community popularity, curviness, or ride type, and sort by newest / ' +
      'oldest / longest / shortest / highest_quality / curviest / ' +
      'most_popular / nearest. `lat`/`lng` are optional for a global feed; ' +
      '`sort = nearest` requires them. `min_curviness` / `max_curviness` ' +
      'exclude rides with no `avg_curviness` computed yet.',
  })
  @ApiResponse({ status: 200, type: CommunityRidesResponseDto })
  async listCommunityRides(
    @Query() query: CommunityRidesQueryDto,
  ): Promise<CommunityRidesResponseDto> {
    return this.sharingService.listCommunityRides(query);
  }
}
