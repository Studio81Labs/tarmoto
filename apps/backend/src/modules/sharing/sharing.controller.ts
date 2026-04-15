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
  CommunityRideDto,
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
  @ApiOperation({ summary: 'Browse community rides nearby' })
  @ApiResponse({ status: 200, type: [CommunityRideDto] })
  async listCommunityRides(
    @Query() query: CommunityRidesQueryDto,
  ): Promise<CommunityRideDto[]> {
    return this.sharingService.listCommunityRides(
      query.lat,
      query.lng,
      query.radius_km ?? 25,
      query.limit ?? 20,
    );
  }
}
