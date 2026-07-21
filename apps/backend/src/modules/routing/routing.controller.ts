import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { RoutingService } from './routing.service.js';
import { RouteRequestDto, RouteResponseDto } from './dto/route.dto.js';
import { requestAbortSignal } from '../../common/request-abort.js';

@ApiTags('routing')
@Controller('routing')
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Post('route')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Road-snapped route through waypoints (live planner preview)',
  })
  @ApiResponse({ status: 201, type: RouteResponseDto })
  @ApiResponse({
    status: 502,
    description: 'Routing engine could not route these points',
  })
  async route(
    @Body() dto: RouteRequestDto,
    @Req() req: Request,
  ): Promise<RouteResponseDto> {
    const requestAbort = requestAbortSignal(req);
    try {
      return await this.routingService.route(dto, requestAbort.signal);
    } finally {
      requestAbort.cleanup();
    }
  }
}
