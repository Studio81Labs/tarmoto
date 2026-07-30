import {
  Body,
  Controller,
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
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { RequireFeature } from '../features/require-feature.decorator.js';
import { GroupRidesService } from './group-rides.service.js';
import { CreateGroupRideDto } from './dto/create-group-ride.dto.js';
import { GroupRideDetailDto } from './dto/group-ride-response.dto.js';
import { FeatureLimitExceededDto } from '../features/dto/feature-limit-exceeded.dto.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';

// Group rides are a premium entitlement (product spec §Monetization).
// FeatureGuard runs after AuthGuard and enforces the group_rides flag
// (tier grant + per-user override + global override) — but per-route,
// not on the whole controller: `leave` and `end` are CLEANUP paths that
// must stay reachable after an entitlement loss, or a revoked rider
// could neither delete their membership + last-known positions nor end
// the ride, leaving stale state visible to the remaining members. Both
// enforce their own membership/owner checks in the service.
@ApiTags('group-rides')
@Controller('group-rides')
@UseGuards(AuthGuard, FeatureGuard)
@ApiBearerAuth()
export class GroupRidesController {
  constructor(private readonly service: GroupRidesService) {}

  @Post()
  @RequireFeature('group_rides')
  @ApiOperation({
    summary: 'Create a group ride and become its owner',
    description:
      'Generates a unique 6-char join code; the creator is automatically ' +
      'added as a member so authorisation reads uniformly off membership.',
  })
  @ApiResponse({ status: 201, type: GroupRideDetailDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateGroupRideDto,
  ): Promise<GroupRideDetailDto> {
    return this.service.create(req.user!.userId, dto);
  }

  @Post(':code/join')
  @RequireFeature('group_rides')
  @ApiOperation({
    summary: 'Join an active group ride by its 6-char code',
    description:
      'Idempotent for existing members. Folds "no such code" and "ride ' +
      'already ended" into the same 404 so the endpoint cannot enumerate ' +
      'historic codes.',
  })
  @ApiParam({
    name: 'code',
    description: 'Six-character invite code, case-insensitive.',
  })
  @ApiExtraModels(FeatureForbiddenDto, FeatureLimitExceededDto)
  @ApiResponse({ status: 201, type: GroupRideDetailDto })
  @ApiResponse({
    status: 403,
    description:
      'Two distinct shapes: (a) the caller lacks the group_rides entitlement ' +
      '— the forbidden envelope (`Feature unavailable: group_rides`) carrying ' +
      '`feature: "group_rides"` but no `code`/`limit`/`current`; or (b) the ' +
      'ride is at its `max_group_ride_members` ' +
      'limit — `FeatureLimitExceededDto` carrying `code: ' +
      '"FEATURE_LIMIT_EXCEEDED"`, `feature: "max_group_ride_members"`, `limit`, ' +
      'and `current`. Discriminate on the presence of `code` (both carry `feature`).',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(FeatureForbiddenDto) },
        { $ref: getSchemaPath(FeatureLimitExceededDto) },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Code not found or ride ended' })
  async join(
    @Req() req: express.Request,
    @Param('code') code: string,
  ): Promise<GroupRideDetailDto> {
    return this.service.join(req.user!.userId, code);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave a group ride; positions are removed immediately',
    description:
      'AC US-26: leaving deletes the membership row outright. If the ' +
      'leaver is the owner OR the last member, the ride is also ended.',
  })
  @ApiResponse({ status: 204, description: 'Left' })
  @ApiResponse({ status: 404, description: 'Ride not found or not a member' })
  async leave(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.leave(req.user!.userId, id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End a group ride (owner only)',
    description:
      'Flips `ended_at`, releases the code for reuse, and emits ' +
      '`group:ended` to all subscribed clients.',
  })
  @ApiResponse({ status: 204, description: 'Ended' })
  @ApiResponse({ status: 404, description: 'Ride not found' })
  @ApiResponse({ status: 403, description: 'Not the owner' })
  async end(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.end(req.user!.userId, id);
  }

  @Get(':id')
  @RequireFeature('group_rides')
  @ApiOperation({
    summary: 'Get group ride detail (members + last-known positions)',
    description:
      'Members-only. Returns each member with their last broadcast ' +
      'position and recent path, for clients that want to render dots ' +
      'and trails immediately on (re)connect.',
  })
  @ApiResponse({ status: 200, type: GroupRideDetailDto })
  @ApiResponse({ status: 404, description: 'Not found or not a member' })
  async getDetail(
    @Req() req: express.Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GroupRideDetailDto> {
    return this.service.getDetail(req.user!.userId, id);
  }
}
