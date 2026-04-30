import {
  Controller,
  Get,
  Post,
  Put,
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
  CommuteAlternativesResponseDto,
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

  @Put('routes/:routeId/primary')
  @ApiOperation({
    summary: 'Mark a commute route as the primary one',
    description:
      'Atomically clears the primary flag on every other saved route ' +
      'for the user and sets it on the target route.',
  })
  @ApiResponse({ status: 200, type: CommuteRouteResponseDto })
  @ApiResponse({ status: 404, description: 'Route not found' })
  async setPrimaryRoute(
    @Req() req: express.Request,
    @Param('routeId', ParseUUIDPipe) routeId: string,
  ): Promise<CommuteRouteResponseDto> {
    return this.commuteService.setPrimaryRoute(req.user!.userId, routeId);
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

  @Get('alternatives')
  @ApiOperation({
    summary: 'Get alternative routes when primary has issues',
  })
  @ApiResponse({ status: 200, type: CommuteAlternativesResponseDto })
  @ApiResponse({ status: 404, description: 'No primary commute route' })
  async getAlternatives(
    @Req() req: express.Request,
  ): Promise<CommuteAlternativesResponseDto> {
    return this.commuteService.getAlternatives(req.user!.userId);
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
