import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { TripActivityListResponseDto } from './dto/activity-response.dto.js';
import { TripActivityService } from './trip-activity.service.js';

@ApiTags('trips')
@Controller('trips/:tripId/activity')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TripActivityController {
  constructor(private readonly service: TripActivityService) {}

  @Get()
  @ApiOperation({ summary: 'List recent activity for a trip (members only)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max entries to return (1-200, default 100).',
  })
  @ApiResponse({ status: 200, type: TripActivityListResponseDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not a member' })
  async list(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<TripActivityListResponseDto> {
    return this.service.list(req.user!.userId, tripId, limit);
  }
}
