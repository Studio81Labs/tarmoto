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
import { CommuteService } from './commute.service.js';
import {
  CreateCommuteRouteDto,
  CommuteStatsQueryDto,
  CommuteRouteResponseDto,
  CommuteStatusResponseDto,
  CommuteStatsResponseDto,
} from './dto/commute.dto.js';

@ApiTags('commute')
@Controller('commute')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class CommuteController {
  constructor(private readonly commuteService: CommuteService) {}

  @Get('routes')
  @ApiOperation({ summary: "Get user's saved commute routes" })
  @ApiResponse({ status: 200, type: [CommuteRouteResponseDto] })
  async listRoutes(
    @Req() req: express.Request,
  ): Promise<CommuteRouteResponseDto[]> {
    return this.commuteService.listRoutes(req.user!.userId);
  }

  @Post('routes')
  @ApiOperation({ summary: 'Save a commute route' })
  @ApiResponse({ status: 201, type: CommuteRouteResponseDto })
  async createRoute(
    @Req() req: express.Request,
    @Body() dto: CreateCommuteRouteDto,
  ): Promise<CommuteRouteResponseDto> {
    return this.commuteService.createRoute(req.user!.userId, dto);
  }

  @Delete('routes/:routeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a commute route' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Route not found' })
  async deleteRoute(
    @Req() req: express.Request,
    @Param('routeId', ParseUUIDPipe) routeId: string,
  ): Promise<void> {
    return this.commuteService.deleteRoute(req.user!.userId, routeId);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get current commute status (hazards, weather, route quality)',
  })
  @ApiResponse({ status: 200, type: CommuteStatusResponseDto })
  @ApiResponse({ status: 404, description: 'No primary commute route' })
  async getStatus(
    @Req() req: express.Request,
  ): Promise<CommuteStatusResponseDto> {
    return this.commuteService.getStatus(req.user!.userId);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get commute statistics' })
  @ApiResponse({ status: 200, type: CommuteStatsResponseDto })
  async getStats(
    @Req() req: express.Request,
    @Query() query: CommuteStatsQueryDto,
  ): Promise<CommuteStatsResponseDto> {
    return this.commuteService.getStats(
      req.user!.userId,
      query.period ?? 'week',
    );
  }
}
