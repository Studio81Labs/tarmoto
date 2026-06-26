import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { RoutingService } from './routing.service.js';
import { RouteRequestDto, RouteResponseDto } from './dto/route.dto.js';

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
  async route(@Body() dto: RouteRequestDto): Promise<RouteResponseDto> {
    return this.routingService.route(dto);
  }
}
