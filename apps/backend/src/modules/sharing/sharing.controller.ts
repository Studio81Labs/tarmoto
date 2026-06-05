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
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { SharingService } from './sharing.service.js';
import {
  ToggleShareDto,
  CommunityRidesQueryDto,
  SharedRideResponseDto,
  SharedRideDetailDto,
  CommunityRidesResponseDto,
  RideLikeResponseDto,
  CloneRideResponseDto,
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

  @Post('shared/:token/embed-click')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Track an outbound click from an embeddable shared-ride widget',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async trackEmbedClick(@Param('token') token: string): Promise<void> {
    await this.sharingService.trackEmbedClick(token);
  }

  @Get('community')
  @UseGuards(OptionalAuthGuard)
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
    @Req() req: express.Request,
    @Query() query: CommunityRidesQueryDto,
  ): Promise<CommunityRidesResponseDto> {
    return this.sharingService.listCommunityRides(query, req.user?.userId);
  }

  @Post(':rideId/like')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Heart a community route' })
  @ApiResponse({ status: 201, type: RideLikeResponseDto })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async likeRide(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideLikeResponseDto> {
    return this.sharingService.likeRide(req.user!.userId, rideId);
  }

  @Delete(':rideId/like')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a heart from a community route' })
  @ApiResponse({ status: 200, type: RideLikeResponseDto })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async unlikeRide(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<RideLikeResponseDto> {
    return this.sharingService.unlikeRide(req.user!.userId, rideId);
  }

  @Post(':rideId/clone')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Clone a community route into a new draft trip' })
  @ApiResponse({ status: 201, type: CloneRideResponseDto })
  @ApiResponse({ status: 400, description: 'Route has no geometry to clone' })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async cloneRide(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<CloneRideResponseDto> {
    return this.sharingService.cloneRide(req.user!.userId, rideId);
  }
}
