import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
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
import { Throttle } from '@nestjs/throttler';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { HazardsService } from './hazards.service.js';
import { CreateHazardDto } from './dto/create-hazard.dto.js';
import { QueryHazardsDto } from './dto/query-hazards.dto.js';
import { RouteHazardsDto } from './dto/route-hazards.dto.js';
import { HazardResponseDto } from './dto/hazard-response.dto.js';

@ApiTags('hazards')
@Controller('hazards')
export class HazardsController {
  constructor(private readonly hazardsService: HazardsService) {}

  @Get()
  @ApiOperation({ summary: 'Get active hazards in area' })
  @ApiResponse({ status: 200, type: [HazardResponseDto] })
  async findNearby(
    @Query() query: QueryHazardsDto,
  ): Promise<HazardResponseDto[]> {
    return this.hazardsService.findNearby(query);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Report a hazard' })
  @ApiResponse({ status: 201, type: HazardResponseDto })
  async create(
    @Req() req: express.Request,
    @Body() dto: CreateHazardDto,
  ): Promise<HazardResponseDto> {
    return this.hazardsService.create(req.user!.userId, dto);
  }

  @Post(':hazardId/confirm')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a hazard is still present' })
  @ApiResponse({ status: 200, type: HazardResponseDto })
  @ApiResponse({ status: 404, description: 'Hazard not found' })
  async confirm(
    @Req() req: express.Request,
    @Param('hazardId', ParseUUIDPipe) hazardId: string,
  ): Promise<HazardResponseDto> {
    return this.hazardsService.confirm(hazardId, req.user!.userId);
  }

  @Post(':hazardId/dismiss')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report hazard is no longer present' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Hazard not found' })
  async dismiss(
    @Param('hazardId', ParseUUIDPipe) hazardId: string,
  ): Promise<void> {
    return this.hazardsService.dismiss(hazardId);
  }

  @Post('route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get hazards along a route' })
  @ApiResponse({ status: 200, type: [HazardResponseDto] })
  async findAlongRoute(
    @Body() dto: RouteHazardsDto,
  ): Promise<HazardResponseDto[]> {
    return this.hazardsService.findAlongRoute(dto);
  }
}
