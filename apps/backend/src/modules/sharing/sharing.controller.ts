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
import { FeatureGuard } from '../features/feature.guard.js';
import { RequireFeature } from '../features/require-feature.decorator.js';
import { FeatureKillSwitchGuard } from '../features/feature-kill-switch.guard.js';
import { RequireFeatureKillSwitch } from '../features/require-feature-kill-switch.decorator.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';
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

  // community_access operator kill (#1207): the companion's server gate on
  // /rides/shared/[token] removes the page, but a leaked token is one curl
  // away from this endpoint — the moderation kill must close the API too.
  // Global-map resolution (FeatureKillSwitchGuard), NOT the per-user
  // snapshot: the route is anonymous.
  @Get('shared/:token')
  @UseGuards(FeatureKillSwitchGuard)
  @RequireFeatureKillSwitch('community_access')
  @ApiOperation({ summary: 'View a shared ride by token (no auth required)' })
  @ApiResponse({ status: 200, type: SharedRideDetailDto })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'community_access is force_off (operator moderation kill). Body is the ' +
      'forbidden envelope carrying `feature: "community_access"` and ' +
      '`scope: "global"` — a temporary shutdown, so keep the link.',
  })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  async getSharedRide(
    @Param('token') token: string,
  ): Promise<SharedRideDetailDto> {
    return this.sharingService.getByToken(token);
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
  // Cloning mints a new draft trip (`SharingService.cloneRide`), so it is a
  // trip-creation path reached from the community feed and carries the same
  // `trip_planning` guard as `POST /trips` (#1164).
  @UseGuards(AuthGuard, FeatureGuard)
  @RequireFeature('trip_planning')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Clone a community route into a new draft trip' })
  @ApiResponse({ status: 201, type: CloneRideResponseDto })
  @ApiResponse({ status: 400, description: 'Route has no geometry to clone' })
  @ApiResponse({ status: 404, description: 'Shared ride not found' })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'The `trip_planning` entitlement is off — `FeatureGuard` rejects with ' +
      'the forbidden envelope carrying `feature: "trip_planning"` plus a ' +
      '`scope` discriminator: `scope: "global"` for the operator kill switch ' +
      '(`force_off`, a temporary shutdown) and `scope: "user"` for a per-user ' +
      'override or tier denial (persistent). Example: ' +
      '`{ message: "Feature unavailable: trip_planning", feature: "trip_planning", scope: "global" }`.',
  })
  async cloneRide(
    @Req() req: express.Request,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ): Promise<CloneRideResponseDto> {
    return this.sharingService.cloneRide(req.user!.userId, rideId);
  }
}
