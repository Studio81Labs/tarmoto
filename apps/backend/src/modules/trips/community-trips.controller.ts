import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import * as express from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { TripsService } from './trips.service.js';
import { PublicTripDetailDto } from './dto/trip-response.dto.js';

/**
 * Public, read-only trip detail for the community surface. Mirrors the way
 * community ride detail reuses the ride read path, but trips have no per-trip
 * public flag, so visibility is collection-scoped: a non-member may read a trip
 * only when it is an item in a discoverable (public/unlisted) collection. The
 * gate lives in {@link TripsService.getPublicDetail}; this controller just
 * threads the optional caller id (members always pass).
 *
 * OptionalAuthGuard (not AuthGuard) so an anonymous reader following a public
 * collection link still resolves, while an authenticated owner reaching their
 * own trip from a private collection is recognised as a member.
 */
@ApiTags('community-trips')
@Controller('community/trips')
export class CommunityTripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get(':tripId')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary:
      'Read-only trip detail for a non-member, when the trip is exposed via ' +
      'a discoverable collection. Masks the invite code and member roster.',
  })
  @ApiResponse({ status: 200, type: PublicTripDetailDto })
  @ApiResponse({
    status: 404,
    description: 'Trip not found or not publicly visible',
  })
  async getPublicDetail(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<PublicTripDetailDto> {
    return this.tripsService.getPublicDetail(req.user?.userId ?? null, tripId);
  }
}
