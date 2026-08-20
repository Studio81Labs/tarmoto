import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { FeatureKillSwitchGuard } from '../features/feature-kill-switch.guard.js';
import { RequireFeatureKillSwitch } from '../features/require-feature-kill-switch.decorator.js';
import { TripSharesService } from './trip-shares.service.js';
import {
  CreateTripShareDto,
  TripShareJoinResponseDto,
  TripShareListResponseDto,
  TripSharePublicDto,
  TripShareResponseDto,
} from './dto/trip-share.dto.js';
import { FeatureLimitExceededDto } from '../features/dto/feature-limit-exceeded.dto.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';

@ApiTags('trip-shares')
@Controller('trip-shares')
export class TripSharesController {
  constructor(private readonly tripSharesService: TripSharesService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a shareable invite link for a trip snapshot (US-35)',
    description:
      'A share attached to a persisted `trip_id` (real collaboration) requires ' +
      'the collaborative_trips entitlement (checked in the service, defense-in-' +
      'depth over the max_trip_collaborators cap). A snapshot-only share (no ' +
      '`trip_id`) is a read-only preview and stays available to all tiers.',
  })
  @ApiResponse({ status: 201, type: TripShareResponseDto })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'A share attached to a persisted `trip_id` was requested without the ' +
      'collaborative_trips entitlement. Body is the forbidden envelope ' +
      '(`Feature unavailable: collaborative_trips`) carrying ' +
      '`feature: "collaborative_trips"` and a `scope` (`"global"` = operator ' +
      '`force_off`, `"user"` = per-user override or the usual tier denial) — ' +
      'NOT a cap rejection, so no `code`/`limit`/`current` fields. ' +
      'Snapshot-only shares (no `trip_id`) never hit this.',
  })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateTripShareDto,
  ): Promise<TripShareResponseDto> {
    return this.tripSharesService.create(req.user!.userId, dto);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the caller's own trip shares" })
  @ApiResponse({ status: 200, type: TripShareListResponseDto })
  async listMine(
    @Req() req: express.Request,
  ): Promise<TripShareListResponseDto> {
    return this.tripSharesService.listMine(req.user!.userId);
  }

  // community_access operator kill (#1207): closes the anonymous API read
  // the companion's server gate on /trips/shared/[token] cannot cover.
  // The authenticated join flow below stays open — accepting an invite is
  // collaboration, not community browsing.
  @Get(':token')
  @UseGuards(FeatureKillSwitchGuard)
  @RequireFeatureKillSwitch('community_access')
  @ApiOperation({
    summary: 'View a shared trip by token (no auth required, read-only)',
  })
  @ApiResponse({ status: 200, type: TripSharePublicDto })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'community_access is force_off (operator moderation kill). Body is the ' +
      'forbidden envelope carrying `feature: "community_access"` and ' +
      '`scope: "global"` — a temporary shutdown, so keep the link.',
  })
  @ApiResponse({ status: 404, description: 'Trip share not found' })
  async getByToken(@Param('token') token: string): Promise<TripSharePublicDto> {
    return this.tripSharesService.getByToken(token);
  }

  @Post(':token/join')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Accept a shared trip token into collaboration membership',
  })
  @ApiResponse({ status: 201, type: TripShareJoinResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Share token resolves to a read-only snapshot only',
  })
  @ApiResponse({
    status: 403,
    type: FeatureLimitExceededDto,
    description:
      'The trip owner is at their collaborator limit — body carries ' +
      '`code: "FEATURE_LIMIT_EXCEEDED"`, `feature: "max_trip_collaborators"`, ' +
      '`limit`, and `current` so a client can distinguish the cap rejection ' +
      'from other failures.',
  })
  @ApiResponse({ status: 404, description: 'Trip share not found' })
  async joinByToken(
    @Req() req: express.Request,
    @Param('token') token: string,
  ): Promise<TripShareJoinResponseDto> {
    return this.tripSharesService.joinByToken(req.user!.userId, token);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a trip share (owner only)' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  @ApiResponse({ status: 404, description: 'Trip share not found' })
  async revoke(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tripSharesService.revoke(req.user!.userId, id);
  }
}
