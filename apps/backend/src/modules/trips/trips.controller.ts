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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeatureGuard } from '../features/feature.guard.js';
import { RequireFeature } from '../features/require-feature.decorator.js';
import { TripsService } from './trips.service.js';
import { TripGeneratorService } from './trip-generator.service.js';
import { CreateTripDto } from './dto/create-trip.dto.js';
import { ImportTripDto } from './dto/import-trip.dto.js';
import { InviteTripDto, InviteTripResponseDto } from './dto/invite-trip.dto.js';
import { JoinTripDto } from './dto/join-trip.dto.js';
import { FeatureLimitExceededDto } from '../features/dto/feature-limit-exceeded.dto.js';
import { FeatureForbiddenDto } from '../features/dto/feature-forbidden.dto.js';
import {
  TripCollaboratorsDto,
  UpdateTripMemberRoleDto,
} from './dto/collaborators.dto.js';
import { ListTripsDto } from './dto/list-trips.dto.js';
import { SaveRouteDto } from './dto/save-route.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { UpdateWaypointNamesDto } from './dto/update-waypoint-names.dto.js';
import {
  TripDetailDto,
  TripInvitePreviewDto,
  TripSummaryDto,
} from './dto/trip-response.dto.js';
import { GenerateTripDto } from './dto/generate-trip.dto.js';
import { GenerateTripResponseDto } from './dto/generate-trip-response.dto.js';
import { requestAbortSignal } from '../../common/request-abort.js';

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
  @UseGuards(FeatureGuard)
  @RequireFeature('gpx_import')
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
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'The `gpx_import` entitlement is off — `FeatureGuard` rejects with the ' +
      'forbidden envelope carrying `feature: "gpx_import"` plus a `scope` ' +
      'discriminator: `scope: "global"` for the operator kill switch ' +
      '(`force_off`, a temporary shutdown) and `scope: "user"` for a per-user ' +
      'override or tier denial (persistent). Example: ' +
      '`{ message: "Feature unavailable: gpx_import", feature: "gpx_import", scope: "global" }`.',
  })
  async importRoute(
    @Req() req: express.Request,
    @Body() dto: ImportTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.importFromRoute(req.user!.userId, dto);
  }

  @Put(':tripId/route')
  @ApiOperation({
    summary: 'Persist a manually-built route (server re-routes from waypoints)',
    description:
      'Any trip member may call this. The server ignores client geometry and ' +
      're-routes through the supplied waypoints via Valhalla, enriches the ' +
      'result via PostGIS, then replaces day 1 atomically. Returns the full ' +
      'updated trip detail. 502 when the routing engine cannot find a road ' +
      'route between the supplied points.',
  })
  @ApiResponse({ status: 200, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  @ApiResponse({
    status: 502,
    description: 'No road route between these points',
  })
  async saveRoute(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: SaveRouteDto,
  ): Promise<TripDetailDto> {
    const requestAbort = requestAbortSignal(req);
    try {
      return await this.tripsService.saveManualRoute(
        req.user!.userId,
        tripId,
        dto,
        requestAbort.signal,
      );
    } finally {
      requestAbort.cleanup();
    }
  }

  @Put(':tripId/import')
  @UseGuards(FeatureGuard)
  @RequireFeature('gpx_import')
  @ApiOperation({
    summary: 'Replace an existing trip with a parsed GPX/KML route',
    description:
      'Owner/admin only. Reuses the same normalised import payload as ' +
      '`POST /trips/import`, but writes the supplied geometry and waypoints ' +
      'into an existing server trip. This keeps collaboration suggestions, ' +
      'activity, invite code, and membership attached to the promoted trip.',
  })
  @ApiResponse({ status: 200, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  @ApiResponse({
    status: 403,
    type: FeatureForbiddenDto,
    description:
      'The `gpx_import` entitlement is off — `FeatureGuard` rejects with the ' +
      'forbidden envelope carrying `feature: "gpx_import"` plus a `scope` ' +
      'discriminator: `scope: "global"` for the operator kill switch ' +
      '(`force_off`, a temporary shutdown) and `scope: "user"` for a per-user ' +
      'override or tier denial (persistent). Example: ' +
      '`{ message: "Feature unavailable: gpx_import", feature: "gpx_import", scope: "global" }`.',
  })
  async replaceImportedRoute(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: ImportTripDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.replaceWithImportedRoute(
      req.user!.userId,
      tripId,
      dto,
    );
  }

  @Patch(':tripId/waypoints')
  @ApiOperation({
    summary: 'Rename waypoints without re-routing',
    description:
      'Any trip editor may call this. Updates only the display names of the ' +
      'listed waypoints (matched by id, scoped to the trip) — geometry, order, ' +
      'and type are untouched and the router is NOT run. Persists e.g. a ' +
      'reverse-geocoded pin name on a loaded trip without reshaping its route.',
  })
  @ApiResponse({ status: 200, type: TripDetailDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async updateWaypointNames(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: UpdateWaypointNamesDto,
  ): Promise<TripDetailDto> {
    return this.tripsService.updateWaypointNames(req.user!.userId, tripId, dto);
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
    const requestAbort = requestAbortSignal(req);
    try {
      return await this.tripGenerator.generate(
        req.user!.userId,
        tripId,
        dto,
        requestAbort.signal,
      );
    } finally {
      requestAbort.cleanup();
    }
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
      'roles. Pass `onlyIfDraft=true` to delete atomically ONLY while the ' +
      'trip is still an unfinished `draft` — used by the client to clean up a ' +
      'planner-kill orphan without risking a route that finished generating ' +
      'in a post-commit race (a non-draft then folds into the same 404).',
  })
  @ApiResponse({ status: 204, description: 'Trip deleted' })
  @ApiResponse({ status: 404, description: 'Trip not found or not owned' })
  async remove(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query('onlyIfDraft') onlyIfDraft?: string,
  ): Promise<void> {
    await this.tripsService.remove(
      req.user!.userId,
      tripId,
      onlyIfDraft === 'true',
    );
  }

  @Get(':tripId/invite/:code/preview')
  @ApiOperation({
    summary: 'Masked pre-join preview for an invited rider',
    description:
      'Read-only route overview + invite context for a logged-in but ' +
      'not-yet-member rider, authorized by a live personal invite code (not ' +
      'membership). Powers the "preview then accept" join screen. Does NOT ' +
      'consume the invite. 404s when the trip or code is unknown/revoked.',
  })
  @ApiResponse({ status: 200, type: TripInvitePreviewDto })
  @ApiResponse({ status: 404, description: 'Invite not found or revoked' })
  async getInvitePreview(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('code') code: string,
  ): Promise<TripInvitePreviewDto> {
    return this.tripsService.getInvitePreview(req.user!.userId, tripId, code);
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

  @Post(':tripId/invite')
  @UseGuards(FeatureGuard)
  @RequireFeature('collaborative_trips')
  @ApiExtraModels(FeatureForbiddenDto, FeatureLimitExceededDto)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a trip invite link to a recipient',
    description:
      'Owner/admin only. Sends a transactional email containing the ' +
      'trip title, an optional personal message, the join URL, and the ' +
      'trip invite code. The recipient does NOT need a Tarmoto account ' +
      'yet — the email explains how to sign up and join. Mail dispatch ' +
      'is best-effort: a delivery failure is logged on the backend but ' +
      'does NOT fail the API call (so 202 here means "queued", not ' +
      '"delivered"). 404s on a non-owner/admin caller, fold into the ' +
      'same response as "no such trip" so the endpoint cannot enumerate ' +
      'trip ids or roles. Requires the collaborative_trips feature ' +
      'entitlement (defense-in-depth over the max_trip_collaborators cap).',
  })
  @ApiResponse({ status: 202, type: InviteTripResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Recipient is the caller themselves (already a member), or body ' +
      'failed validation (bad email, message > 500 chars).',
  })
  @ApiResponse({
    status: 403,
    description:
      'Two distinct shapes: (a) the caller lacks the collaborative_trips ' +
      'entitlement — the forbidden envelope (`Feature unavailable: ' +
      'collaborative_trips`) carrying `feature: "collaborative_trips"` but no ' +
      '`code`/`limit`/`current`; or (b) the trip owner is at ' +
      'their collaborator limit — `FeatureLimitExceededDto` carrying `code: ' +
      '"FEATURE_LIMIT_EXCEEDED"`, `feature: "max_trip_collaborators"`, `limit`, ' +
      'and `current`. Discriminate on the presence of `code` (both carry ' +
      '`feature`; the forbidden shape also carries `scope`: "global" for a ' +
      '`force_off` kill or "user" for a per-user/tier denial).',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(FeatureForbiddenDto) },
        { $ref: getSchemaPath(FeatureLimitExceededDto) },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Trip not found or not owned' })
  async invite(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: InviteTripDto,
  ): Promise<InviteTripResponseDto> {
    await this.tripsService.invite(req.user!.userId, tripId, dto);
    return { status: 'queued' };
  }

  @Get(':tripId/members')
  @ApiOperation({
    summary: 'Collaborator roster: joined members + pending invites',
    description:
      'Any member can list the roster. Emails and the pending-invite ' +
      'list are only included when the caller is the owner or an ' +
      'editor — viewers get names and roles only.',
  })
  @ApiResponse({ status: 200, type: TripCollaboratorsDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not a member' })
  async listCollaborators(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<TripCollaboratorsDto> {
    return this.tripsService.listCollaborators(req.user!.userId, tripId);
  }

  @Patch(':tripId/members/:memberUserId')
  @ApiOperation({
    summary: "Change a member's role (owner only)",
    description:
      'Switch a collaborator between `editor` and `viewer`. The owner ' +
      'role is fixed — it cannot be assigned or removed.',
  })
  @ApiResponse({ status: 200, type: TripCollaboratorsDto })
  @ApiResponse({ status: 403, description: 'Caller is not the owner' })
  @ApiResponse({ status: 404, description: 'Trip or member not found' })
  async updateMemberRole(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
    @Body() dto: UpdateTripMemberRoleDto,
  ): Promise<TripCollaboratorsDto> {
    return this.tripsService.updateMemberRole(
      req.user!.userId,
      tripId,
      memberUserId,
      dto.role,
    );
  }

  @Delete(':tripId/members/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave a trip you collaborate on (self-removal)',
    description:
      'Viewers and editors can remove themselves; the owner has no ' +
      'leave path (deleting the trip is their only exit) and gets a 400. ' +
      'Past suggestions, votes, and messages stay in the history.',
  })
  @ApiResponse({ status: 204, description: 'Left the trip' })
  @ApiResponse({
    status: 400,
    description: 'The owner cannot leave their own trip',
  })
  @ApiResponse({ status: 404, description: 'Not a member of this trip' })
  async leaveTrip(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<void> {
    await this.tripsService.leaveTrip(req.user!.userId, tripId);
  }

  @Delete(':tripId/members/:memberUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member from the trip (owner only)',
    description:
      'Revokes access from now on; the removed rider\u2019s past ' +
      'suggestions, votes, and messages stay in the history.',
  })
  @ApiResponse({ status: 204, description: 'Member removed' })
  @ApiResponse({ status: 403, description: 'Caller is not the owner' })
  @ApiResponse({ status: 404, description: 'Trip or member not found' })
  async removeMember(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
  ): Promise<void> {
    await this.tripsService.removeMember(
      req.user!.userId,
      tripId,
      memberUserId,
    );
  }

  @Delete(':tripId/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw a pending email invite (owner only)',
    description:
      'Deletes the pending invite; the personal invite code in the ' +
      'already-sent mail stops working immediately.',
  })
  @ApiResponse({ status: 204, description: 'Invite revoked' })
  @ApiResponse({ status: 403, description: 'Caller is not the owner' })
  @ApiResponse({ status: 404, description: 'Trip or invite not found' })
  async revokeInvite(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<void> {
    await this.tripsService.revokeInvite(req.user!.userId, tripId, inviteId);
  }
}
